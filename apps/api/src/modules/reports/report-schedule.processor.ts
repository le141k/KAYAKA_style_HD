/**
 * BullMQ processor for the 'reports' queue.
 * Handles the repeatable 'schedule-scan' job: finds enabled schedules
 * where nextRunAt <= now, runs the report, sends CSV/JSON email, updates nextRunAt.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
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

// concurrency:1 + a long lockDuration so two scans can't overlap and double-send
// a scheduled report (the nextRunAt "claim" is written only after the email send).
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
      cron: string;
      recipients: string[];
      isEnabled: boolean;
      format: string;
      lastRunAt: Date | null;
      nextRunAt: Date | null;
      report: { id: number; title: string; definition: unknown };
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

      try {
        // Re-parse stored definition through schema (injection-safe)
        const parsed = ReportDefinitionSchema.safeParse(schedule.report.definition);
        if (!parsed.success) {
          throw new Error(`Invalid report definition: ${JSON.stringify(parsed.error.flatten())}`);
        }

        const rows = await this.compiler.compile(parsed.data);
        rowCount = rows.length;

        // Send email with results
        const recipients = (schedule.recipients as string[]) ?? [];
        if (recipients.length > 0) {
          const isCSV = (schedule.format ?? 'json') === 'csv';
          if (isCSV) {
            const csvContent = toCsv(rows as Record<string, unknown>[]);
            await this.mailService.send({
              to: recipients,
              subject: `Report: ${schedule.report.title}`,
              text: `Scheduled report results (${rowCount} rows):\n\n${csvContent}`,
            });
          } else {
            await this.mailService.send({
              to: recipients,
              subject: `Report: ${schedule.report.title}`,
              text: `Scheduled report results (${rowCount} rows):\n\n${JSON.stringify(rows, null, 2)}`,
            });
          }
        }
      } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to run scheduled report ${schedule.reportId}: ${errorMsg}`);
      }

      const durationMs = Date.now() - start;
      const nextRunAt = advanceNextRunAt(schedule.cron, now);

      // Record the run
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.prisma as any).reportRun.create({
        data: {
          reportId: schedule.reportId,
          triggeredBy: 'schedule',
          rowCount,
          durationMs,
          error: errorMsg ?? null,
        },
      });

      // Advance schedule
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (this.prisma.reportSchedule as any).update({
        where: { id: schedule.id },
        data: { lastRunAt: now, nextRunAt },
      });
    }

    this.logger.debug('Reports schedule-scan complete');
  }
}
