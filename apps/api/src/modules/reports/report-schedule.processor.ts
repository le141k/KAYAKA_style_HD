/**
 * BullMQ processor for the 'reports' queue.
 * Handles the repeatable 'schedule-scan' job: finds enabled schedules
 * where nextRunAt <= now, runs the report, sends CSV/JSON email, updates nextRunAt.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSIONS } from '../../auth/permissions';
import { MailService } from '../mail/mail.service';
import type { TicketAccessActor } from '../tickets/ticket-access-policy.service';
import { ReportCompiler } from './report-compiler';
import { ReportDefinitionSchema } from './report-definition.schema';
import { toCsv } from './reports.utils';
import { nextRunFromCron } from './cron.util';

/**
 * Advance nextRunAt to the next cron fire time after `from`. Falls back to +1h
 * if the stored cron is unparseable (shouldn't happen — validated on write).
 */
function advanceNextRunAt(cron: string, from: Date): Date {
  try {
    return nextRunFromCron(cron, from);
  } catch {
    return new Date(from.getTime() + 60 * 60_000);
  }
}

/** A permanent owner problem: fail closed and stop the schedule until an admin recreates it. */
class ScheduleOwnerUnavailableError extends Error {}

/**
 * The exact authorization material used to compile a scheduled report.  It is
 * intentionally richer than TicketAccessActor: a later staff disable, group
 * permission change, or DepartmentStaff edit must invalidate a compiled result
 * before that result becomes a durable customer email command.
 */
interface OwnerAuthorizationFingerprint {
  staffId: number;
  isEnabled: boolean;
  isAdmin: boolean;
  permissions: string[];
  departmentIds: number[];
}

interface ResolvedScheduleOwner {
  actor: TicketAccessActor;
  fingerprint: OwnerAuthorizationFingerprint;
}

function canonicalStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function canonicalDepartmentIds(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function fingerprintEquals(a: OwnerAuthorizationFingerprint, b: OwnerAuthorizationFingerprint): boolean {
  return (
    a.staffId === b.staffId &&
    a.isEnabled === b.isEnabled &&
    a.isAdmin === b.isAdmin &&
    a.permissions.length === b.permissions.length &&
    a.permissions.every((permission, index) => permission === b.permissions[index]) &&
    a.departmentIds.length === b.departmentIds.length &&
    a.departmentIds.every((departmentId, index) => departmentId === b.departmentIds[index])
  );
}

// Local concurrency reduces duplicate compilation; the transaction-local due CAS
// below is the actual cross-process fence for a scheduled report + email command.
@Processor('reports', { concurrency: 1, lockDuration: 300_000 })
export class ReportScheduleProcessor extends WorkerHost {
  private readonly logger = new Logger(ReportScheduleProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly compiler: ReportCompiler,
    private readonly mailService: MailService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'schedule-scan') return;

    this.logger.debug('Reports schedule-scan started');

    const now = new Date();

    // Find enabled schedules that are due; nextRunAt column added by migration
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dueSchedules = (await (this.prisma.reportSchedule as any).findMany({
      where: {
        isEnabled: true,
        nextRunAt: { lte: now },
      },
      include: { report: true },
    })) as Array<{
      id: number;
      reportId: number;
      ownerStaffId: number | null;
      cron: string;
      recipients: string[];
      isEnabled: boolean;
      format: string;
      configGeneration: number;
      lastRunAt: Date | null;
      nextRunAt: Date | null;
      report: { id: number; title: string; definition: unknown; configGeneration: number };
    }>;

    if (dueSchedules.length === 0) {
      this.logger.debug('No due report schedules');
      return;
    }

    this.logger.log(`Processing ${dueSchedules.length} due report schedule(s)`);

    for (const schedule of dueSchedules) {
      const start = Date.now();
      let rowCount = 0;
      let errorMsg: string | undefined;
      let disableSchedule = false;
      let reportText: string | undefined;
      let reportRecipients: string[] = [];
      let ownerFingerprint: OwnerAuthorizationFingerprint | undefined;

      try {
        // Re-parse stored definition through schema (injection-safe)
        const parsed = ReportDefinitionSchema.safeParse(schedule.report.definition);
        if (!parsed.success) {
          throw new Error(`Invalid report definition: ${JSON.stringify(parsed.error.flatten())}`);
        }

        // Scheduled execution has no HTTP principal.  Resolve and re-authorize
        // the persisted owner at run time; a disabled/de-privileged/missing
        // owner must never turn this into a global aggregate query.
        const owner = await this.resolveScheduleOwner(schedule.ownerStaffId);
        ownerFingerprint = owner.fingerprint;
        const rows = await this.compiler.compile(parsed.data, owner.actor);
        rowCount = rows.length;

        // Build an immutable text snapshot.  Delivery is committed below as a
        // durable outbox command in the same transaction as ReportRun and the
        // schedule cursor; never call the legacy volatile mail.send() path.
        if (
          !Array.isArray(schedule.recipients) ||
          !schedule.recipients.every((recipient) => typeof recipient === 'string')
        ) {
          throw new Error('Scheduled report recipients are invalid');
        }
        reportRecipients = schedule.recipients;
        if (reportRecipients.length > 0) {
          const isCSV = (schedule.format ?? 'json') === 'csv';
          const contents = isCSV ? toCsv(rows as Record<string, unknown>[]) : JSON.stringify(rows, null, 2);
          reportText = `Scheduled report results (${rowCount} rows):\n\n${contents}`;
          if (reportText.length > 5_000_000) {
            throw new Error('Scheduled report email body exceeds 5000000 characters');
          }
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        disableSchedule = err instanceof ScheduleOwnerUnavailableError;
        this.logger.error(`Failed to run scheduled report ${schedule.reportId}: ${errorMsg}`);
      }

      const durationMs = Date.now() - start;
      const nextRunAt = advanceNextRunAt(schedule.cron, now);
      // `nextRunAt` cannot be NULL after the SQL due predicate.  The fallback
      // only keeps legacy unit doubles deterministic; a real nullable row is
      // not eligible for this processor query.
      const expectedNextRunAt = schedule.nextRunAt ?? now;
      const expectedScheduleGeneration = Number.isInteger(schedule.configGeneration)
        ? schedule.configGeneration
        : 0;
      const expectedReportGeneration = Number.isInteger(schedule.report.configGeneration)
        ? schedule.report.configGeneration
        : 0;
      const scheduleFire = expectedNextRunAt.toISOString();

      try {
        const committed = await this.prisma.$transaction(
          async (tx) => {
            // The report data was compiled before this transaction. Re-read the
            // complete authorization fingerprint before any schedule/run/outbox
            // write: a revoked staff member or changed department scope cannot
            // cause their already-compiled cross-department aggregate to email.
            if (
              ownerFingerprint &&
              !(await this.ownerFingerprintMatchesInTransaction(tx, ownerFingerprint))
            ) {
              return null;
            }

            // The scanner is replicated in production.  Put the due predicate in
            // the mutation so only one process can record this exact immutable
            // schedule/report snapshot and create its command.  A concurrent
            // config edit (recipient, owner, format, cron or report definition)
            // wins by advancing a generation or changing an exact identity below.
            const claimed = await tx.reportSchedule.updateMany({
              where: {
                id: schedule.id,
                reportId: schedule.reportId,
                ownerStaffId: schedule.ownerStaffId,
                isEnabled: true,
                nextRunAt: expectedNextRunAt,
                configGeneration: expectedScheduleGeneration,
                report: {
                  is: {
                    id: schedule.report.id,
                    configGeneration: expectedReportGeneration,
                  },
                },
              },
              data: {
                lastRunAt: now,
                nextRunAt,
                ...(disableSchedule ? { isEnabled: false } : {}),
              },
            });
            if (claimed.count !== 1) return null;

            const run = await tx.reportRun.create({
              data: {
                reportId: schedule.reportId,
                triggeredBy: 'schedule',
                staffId: schedule.ownerStaffId,
                rowCount,
                durationMs,
                error: errorMsg ?? null,
              },
              select: { id: true },
            });

            if (!reportText || errorMsg) return { outboundEmailId: undefined };
            const outbox = await this.mailService.createReportEmail(tx, {
              reportRunId: run.id,
              to: reportRecipients,
              subject: `Report: ${schedule.report.title}`,
              text: reportText,
              // Schedule id + the actual due timestamp is immutable for this
              // firing.  It backs up the mutation CAS if a future code path ever
              // attempts to replay the same fire after a crash.
              idempotencyKey: `report-schedule:${schedule.id}:fire:${scheduleFire}`,
            });
            return { outboundEmailId: outbox.id };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        if (committed?.outboundEmailId) {
          // Redis remains only a latency wake-up.  The transaction already made
          // the report command + its observable ReportRun status durable.
          this.mailService
            .enqueueOutbound(committed.outboundEmailId)
            .catch((err: unknown) =>
              this.logger.error(
                `Scheduled report ${schedule.reportId} outbox wake-up failed ` +
                  `(${err instanceof Error && err.name ? err.name.slice(0, 80) : 'UnknownError'})`,
              ),
            );
        }
      } catch (err) {
        // A failed transaction did not advance the due cursor, so the scanner
        // retries safely.  In particular it never records a report as mailed
        // merely because a transient Redis/SMTP path was unavailable.
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to persist scheduled report ${schedule.reportId}: ${message}`);
      }
    }

    this.logger.debug('Reports schedule-scan complete');
  }

  private async resolveScheduleOwner(ownerStaffId: number | null): Promise<ResolvedScheduleOwner> {
    if (ownerStaffId === null) {
      throw new ScheduleOwnerUnavailableError('Scheduled report has no owner and was disabled');
    }

    const owner = await this.prisma.staff.findUnique({
      where: { id: ownerStaffId },
      select: {
        id: true,
        isEnabled: true,
        staffGroup: { select: { isAdmin: true, permissions: true } },
        departments: { select: { departmentId: true } },
      },
    });
    if (!owner || !owner.isEnabled) {
      throw new ScheduleOwnerUnavailableError(
        'Scheduled report owner is unavailable and the schedule was disabled',
      );
    }
    if (!owner.staffGroup.isAdmin && !owner.staffGroup.permissions.includes(PERMISSIONS.REPORT_RUN)) {
      throw new ScheduleOwnerUnavailableError(
        'Scheduled report owner no longer has report.run permission and the schedule was disabled',
      );
    }

    return {
      actor: { staffId: owner.id, isAdmin: owner.staffGroup.isAdmin },
      fingerprint: this.ownerFingerprint(owner),
    };
  }

  /** Re-read all RBAC material in the same short SERIALIZABLE persistence tx. */
  private async ownerFingerprintMatchesInTransaction(
    tx: Prisma.TransactionClient,
    expected: OwnerAuthorizationFingerprint,
  ): Promise<boolean> {
    const owner = await tx.staff.findUnique({
      where: { id: expected.staffId },
      select: {
        id: true,
        isEnabled: true,
        staffGroup: { select: { isAdmin: true, permissions: true } },
        departments: { select: { departmentId: true } },
      },
    });
    return owner !== null && fingerprintEquals(expected, this.ownerFingerprint(owner));
  }

  private ownerFingerprint(owner: {
    id: number;
    isEnabled: boolean;
    staffGroup: { isAdmin: boolean; permissions: string[] };
    departments: Array<{ departmentId: number }>;
  }): OwnerAuthorizationFingerprint {
    return {
      staffId: owner.id,
      isEnabled: owner.isEnabled,
      isAdmin: owner.staffGroup.isAdmin,
      permissions: canonicalStrings(owner.staffGroup.permissions),
      departmentIds: canonicalDepartmentIds(owner.departments.map(({ departmentId }) => departmentId)),
    };
  }
}
