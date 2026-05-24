import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';
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
  async run(id: number, triggeredBy: 'manual' | 'schedule' = 'manual', staffId?: number) {
    const report = await this.prisma.report.findUniqueOrThrow({ where: { id } });

    // Re-parse to validate (closes injection gap for legacy-stored definitions)
    const parsed = ReportDefinitionSchema.safeParse(report.definition);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    const start = Date.now();
    let rows: Record<string, unknown>[] = [];
    let error: string | undefined;

    try {
      rows = await this.compiler.compile(parsed.data);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const durationMs = Date.now() - start;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (this.prisma as any).reportRun.create({
      data: {
        reportId: id,
        triggeredBy,
        staffId: staffId ?? null,
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
  async execute(def: unknown) {
    const parsed = ReportDefinitionSchema.safeParse(def);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.compiler.compile(parsed.data);
  }

  /** Convenience dashboard summary used by the staff home screen. */
  async dashboard() {
    const now = new Date();
    const startOfDay = new Date(new Date().setHours(0, 0, 0, 0));
    // U-high: exclude merged-away tickets from all dashboard counts so the card
    // totals match the ticket-list page (which already filters mergedIntoId:null).
    const notMerged = { mergedIntoId: null } as const;
    const [byStatus, byPriority, total, resolved, slaBreached, avgRows] = await Promise.all([
      this.prisma.ticket.groupBy({
        by: ['statusId'],
        where: notMerged,
        _count: { _all: true },
      }),
      this.prisma.ticket.groupBy({
        by: ['priorityId'],
        where: notMerged,
        _count: { _all: true },
      }),
      this.prisma.ticket.count({ where: notMerged }),
      // "resolved today" — resolved with resolvedAt since local midnight
      this.prisma.ticket.count({
        where: {
          ...notMerged,
          isResolved: true,
          resolvedAt: { gte: startOfDay },
        },
      }),
      // SLA breached: past due and not yet resolved
      this.prisma.ticket.count({ where: { ...notMerged, isResolved: false, dueAt: { lt: now } } }),
      // Avg first-response time computed DB-side (no unbounded findMany).
      // AVG over (firstResponseAt - createdAt) in minutes for responded tickets.
      this.prisma.$queryRaw<{ avg_minutes: number | null }[]>`
        SELECT AVG(EXTRACT(EPOCH FROM ("firstResponseAt" - "createdAt")) / 60) AS avg_minutes
        FROM "Ticket"
        WHERE "firstResponseAt" IS NOT NULL
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

  async createSchedule(reportId: number, dto: z.infer<typeof ScheduleCreateSchema>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma.reportSchedule as any).create({
      data: {
        reportId,
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

  async listSchedules(reportId: number) {
    return this.prisma.reportSchedule.findMany({ where: { reportId } });
  }

  async updateSchedule(scheduleId: number, dto: Partial<z.infer<typeof ScheduleCreateSchema>>) {
    // Recompute the next fire time when the cron expression changes.
    const data: Record<string, unknown> = { ...dto };
    if (dto.cron) data['nextRunAt'] = nextRunFromCron(dto.cron, new Date());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.prisma.reportSchedule as any).update({ where: { id: scheduleId }, data });
  }

  async removeSchedule(scheduleId: number) {
    return this.prisma.reportSchedule.delete({ where: { id: scheduleId } });
  }
}

// Re-export toCsv for controller use
export { _toCsv as toCsvUtil };
