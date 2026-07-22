import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { PrismaService } from '../../prisma/prisma.service';
import { TicketAccessPolicy, type TicketAccessActor } from '../tickets/ticket-access-policy.service';
import { ReportDefinitionSchema, ReportDefinition } from './report-definition.schema';
import { ReportCompiler } from './report-compiler';
import { toCsv as _toCsv } from './reports.utils';
import { isValidCron, nextRunFromCron } from './cron.util';

// ─── DTOs (re-exported for use in module) ─────────────────────────────────────

export const ReportCreateSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(['TABULAR', 'SUMMARY', 'MATRIX']).default('SUMMARY'),
  definition: ReportDefinitionSchema,
});

export const ReportUpdateSchema = ReportCreateSchema.partial();

export const ScheduleCreateSchema = z.object({
  cron: z.string().min(1).refine(isValidCron, { message: 'Invalid cron expression' }),
  recipients: z.array(z.string().email()).default([]),
  isEnabled: z.boolean().default(true),
  format: z.enum(['json', 'csv']).default('json'),
});

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly compiler: ReportCompiler,
    private readonly ticketAccess: TicketAccessPolicy,
  ) {}

  list() {
    return this.prisma.report.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(dto: z.infer<typeof ReportCreateSchema>) {
    // Validate definition via schema (prevents injection via stored definition)
    const parsed = ReportDefinitionSchema.safeParse(dto.definition);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.prisma.report.create({
      data: { title: dto.title, kind: dto.kind, definition: parsed.data },
    });
  }

  async update(id: number, dto: z.infer<typeof ReportUpdateSchema>) {
    let definition: ReportDefinition | undefined;
    if (dto.definition !== undefined) {
      const parsed = ReportDefinitionSchema.safeParse(dto.definition);
      if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
      definition = parsed.data;
    }
    return this.prisma.report.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
        ...(definition !== undefined ? { definition } : {}),
      },
    });
  }

  async remove(id: number) {
    return this.prisma.report.delete({ where: { id } });
  }

  /**
   * Executes a stored report's definition and returns aggregated rows.
   * Re-parses the stored definition through the schema before executing
   * to close the injection gap.
   */
  async run(id: number, actor: TicketAccessActor, triggeredBy: 'manual' | 'schedule' = 'manual') {
    const report = await this.prisma.report.findUniqueOrThrow({ where: { id } });

    // Re-parse to validate (closes injection gap for legacy-stored definitions)
    const parsed = ReportDefinitionSchema.safeParse(report.definition);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const start = Date.now();
    let rows: Record<string, unknown>[] = [];
    let error: string | undefined;

    try {
      // The caller's ticket predicate is part of the report query itself.  Do
      // not fetch global rows and filter them in memory: grouping/counts would
      // still disclose the other departments.
      rows = await this.compiler.compile(parsed.data, actor);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - start;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.prisma as any).reportRun.create({
      data: {
        reportId: id,
        triggeredBy,
        staffId: actor.staffId,
        rowCount: rows.length,
        durationMs,
        error: error ?? null,
      },
    });

    if (error) throw new BadRequestException(error);
    return rows;
  }

  async listRuns(reportId: number) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma as any).reportRun.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Ad-hoc execution of a definition (used by dashboards). */
  async execute(def: unknown, actor: TicketAccessActor) {
    const parsed = ReportDefinitionSchema.safeParse(def);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.compiler.compile(parsed.data, actor);
  }

  /** Convenience dashboard summary used by the staff home screen. */
  async dashboard(actor: TicketAccessActor) {
    const now = new Date();
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
    // U-high: exclude merged-away tickets from all dashboard counts so the card
    // totals match the ticket-list page (which already filters mergedIntoId:null).
    const notMerged = { mergedIntoId: null } as const;
    // Resolve once, so every dashboard card describes the same department
    // visibility snapshot rather than a mixture of old and new assignments.
    const departmentScope = await this.ticketAccess.resolveScope(actor);
    const ticketScope = this.ticketAccess.ticketWhereForScope(departmentScope);
    const scopedNotMerged: Prisma.TicketWhereInput = { AND: [notMerged, ticketScope] };
    const scopedResolved: Prisma.TicketWhereInput = {
      AND: [notMerged, ticketScope, { isResolved: true, resolvedAt: { gte: startOfDay } }],
    };
    const scopedSlaBreached: Prisma.TicketWhereInput = {
      AND: [notMerged, ticketScope, { isResolved: false, dueAt: { lt: now } }],
    };
    // Prisma's structured predicates treat `in: []` as no rows. The raw AVG
    // query needs the same fail-closed semantics explicitly: `IN ()` is invalid
    // PostgreSQL, and dropping the clause would leak every department.
    const rawDepartmentClause = departmentScope.unrestricted
      ? Prisma.empty
      : departmentScope.departmentIds.length === 0
        ? Prisma.sql` AND FALSE`
        : Prisma.sql` AND "departmentId" IN (${Prisma.join(departmentScope.departmentIds)})`;
    const [byStatus, byPriority, total, resolved, slaBreached, avgRows] = await Promise.all([
      this.prisma.ticket.groupBy({
        by: ['statusId'],
        where: scopedNotMerged,
        _count: { _all: true },
      }),
      this.prisma.ticket.groupBy({
        by: ['priorityId'],
        where: scopedNotMerged,
        _count: { _all: true },
      }),
      this.prisma.ticket.count({ where: scopedNotMerged }),
      // "resolved today" — resolved with resolvedAt since local midnight
      this.prisma.ticket.count({ where: scopedResolved }),
      // SLA breached: past due and not yet resolved
      this.prisma.ticket.count({ where: scopedSlaBreached }),
      // Avg first-response time computed DB-side (no unbounded findMany).
      // AVG over (firstResponseAt - createdAt) in minutes for responded tickets.
      this.prisma.$queryRaw<{ avg_minutes: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt")) / 60) AS avg_minutes
        FROM "Ticket"
        WHERE "firstResponseAt" IS NOT NULL AND "mergedIntoId" IS NULL${rawDepartmentClause}
      `,
    ]);
    const rawAvg = avgRows?.[0]?.avg_minutes;
    const avgFirstResponseMinutes = rawAvg === null || rawAvg === undefined ? 0 : Math.round(Number(rawAvg));

    const byStatusMapped = byStatus.map((r) => ({ key: r.statusId, count: r._count._all }));
    const byPriorityMapped = byPriority.map((r) => ({ key: r.priorityId, count: r._count._all }));

    return {
      total,
      resolved,
      slaBreached,
      avgFirstResponseMinutes,
      byStatus: byStatusMapped,
      byPriority: byPriorityMapped,
    };
  }

  // ─── Schedule CRUD ────────────────────────────────────────────────────────

  async createSchedule(reportId: number, dto: z.infer<typeof ScheduleCreateSchema>, actor: AuthStaff) {
    // A scheduled report has no request-time principal.  It must therefore run
    // under an explicit owner who is currently entitled to run reports; never
    // create an ownerless job that a worker could accidentally execute globally.
    if (!actor.isAdmin && !actor.permissions.includes(PERMISSIONS.REPORT_RUN)) {
      throw new ForbiddenException('A report schedule owner must have report.run permission');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma.reportSchedule as any).create({
      data: {
        reportId,
        ownerStaffId: actor.staffId,
        cron: dto.cron,
        recipients: dto.recipients,
        isEnabled: dto.isEnabled,
        format: dto.format,
        // Seed the first fire time from the cron so the processor can pick it up
        // (a NULL nextRunAt is never `<= now`, so the schedule would never run).
        nextRunAt: nextRunFromCron(dto.cron, new Date()),
      },
    });
  }

  async listSchedules(reportId: number, actor: TicketAccessActor) {
    return this.prisma.reportSchedule.findMany({
      where: {
        reportId,
        ...(actor.isAdmin ? {} : { ownerStaffId: actor.staffId }),
      },
    });
  }

  async updateSchedule(
    scheduleId: number,
    dto: Partial<z.infer<typeof ScheduleCreateSchema>>,
    actor: TicketAccessActor,
  ) {
    // Recompute the next fire time when the cron expression changes.
    const data: Record<string, unknown> = { ...dto };
    if (dto.cron) data['nextRunAt'] = nextRunFromCron(dto.cron, new Date());
    if (actor.isAdmin) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (this.prisma.reportSchedule as any).update({ where: { id: scheduleId }, data });
    }

    // Ownership is in the mutation predicate, not just a preceding read. A
    // concurrent admin ownership change cannot turn a stale authorization
    // check into a cross-department recipient update.
    const updated = await this.prisma.reportSchedule.updateMany({
      where: { id: scheduleId, ownerStaffId: actor.staffId },
      data,
    });
    if (updated.count !== 1) throw new NotFoundException('Report schedule not found');
    const schedule = await this.prisma.reportSchedule.findFirst({
      where: { id: scheduleId, ownerStaffId: actor.staffId },
    });
    if (!schedule) throw new NotFoundException('Report schedule not found');
    return schedule;
  }

  async removeSchedule(scheduleId: number, actor: TicketAccessActor) {
    if (actor.isAdmin) return this.prisma.reportSchedule.delete({ where: { id: scheduleId } });

    // `deleteMany` puts owner + id in one SQL predicate. Return the already
    // authorized row only after the conditional delete succeeds; no unscoped
    // delete follows an ownership preflight read.
    const schedule = await this.prisma.reportSchedule.findFirst({
      where: { id: scheduleId, ownerStaffId: actor.staffId },
    });
    if (!schedule) throw new NotFoundException('Report schedule not found');
    const deleted = await this.prisma.reportSchedule.deleteMany({
      where: { id: scheduleId, ownerStaffId: actor.staffId },
    });
    if (deleted.count !== 1) throw new NotFoundException('Report schedule not found');
    return schedule;
  }
}

// Re-export toCsv for controller use
export { _toCsv as toCsvUtil };
