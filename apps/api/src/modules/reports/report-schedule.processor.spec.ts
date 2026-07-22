import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportScheduleProcessor } from './report-schedule.processor';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import type { ReportCompiler } from './report-compiler';

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePrismaMock() {
  // reportRun and reportSchedule.update with new fields are from our migration;
  // cast as any since generated PrismaClient types may not reflect local migration yet.
  return {
    reportSchedule: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    // New model added by migration
    reportRun: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
    },
    staff: {
      findUnique: vi.fn().mockResolvedValue({
        id: 7,
        isEnabled: true,
        staffGroup: { isAdmin: false, permissions: ['report.run'] },
      }),
    },
  } as unknown as PrismaService;
}

function makeCompilerMock() {
  return {
    compile: vi.fn().mockResolvedValue([]),
  } as unknown as ReportCompiler;
}

function makeMailMock() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as MailService;
}

function makeJob(name = 'schedule-scan') {
  return { id: 'test-job-1', name } as unknown as import('bullmq').Job;
}

const VALID_DEFINITION = {
  source: 'tickets',
  filters: [],
  groupBy: ['statusId'],
  aggregates: [{ func: 'count' }],
  limit: 100,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ReportScheduleProcessor', () => {
  let processor: ReportScheduleProcessor;
  let prisma: ReturnType<typeof makePrismaMock>;
  let compiler: ReturnType<typeof makeCompilerMock>;
  let mail: ReturnType<typeof makeMailMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    compiler = makeCompilerMock();
    mail = makeMailMock();
    processor = new ReportScheduleProcessor(
      prisma as unknown as PrismaService,
      compiler as unknown as ReportCompiler,
      mail as unknown as MailService,
    );
  });

  // ─── Skips non-schedule-scan jobs ────────────────────────────────────────

  it('skips jobs with name other than schedule-scan', async () => {
    await processor.process(makeJob('other-job'));
    expect(prisma.reportSchedule.findMany).not.toHaveBeenCalled();
  });

  // ─── Skips disabled schedules ─────────────────────────────────────────────

  it('skips when no due schedules are found', async () => {
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await processor.process(makeJob());

    expect(compiler.compile).not.toHaveBeenCalled();
    expect(prisma.reportRun.create).not.toHaveBeenCalled();
  });

  // ─── Creates ReportRun on success ─────────────────────────────────────────

  it('creates a ReportRun with correct data on success', async () => {
    const mockRows = [
      { statusId: 1, count: 5 },
      { statusId: 2, count: 3 },
    ];
    (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows);
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        reportId: 42,
        ownerStaffId: 7,
        cron: '0 * * * *',
        recipients: [],
        isEnabled: true,
        format: 'json',
        report: { id: 42, title: 'Test Report', definition: VALID_DEFINITION },
      },
    ]);

    await processor.process(makeJob());

    expect(compiler.compile).toHaveBeenCalledWith(VALID_DEFINITION, { staffId: 7, isAdmin: false });
    expect(prisma.reportRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reportId: 42,
          triggeredBy: 'schedule',
          staffId: 7,
          rowCount: 2,
          error: null,
        }),
      }),
    );
  });

  // ─── Updates lastRunAt and nextRunAt ──────────────────────────────────────

  it('updates schedule lastRunAt and nextRunAt after run', async () => {
    (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 7,
        reportId: 1,
        ownerStaffId: 7,
        cron: '0 0 * * *',
        recipients: [],
        isEnabled: true,
        format: 'json',
        report: { id: 1, title: 'R', definition: VALID_DEFINITION },
      },
    ]);

    await processor.process(makeJob());

    expect(prisma.reportSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          lastRunAt: expect.any(Date),
          nextRunAt: expect.any(Date),
        }),
      }),
    );
  });

  // ─── Sends email when recipients present ─────────────────────────────────

  it('sends email via MailService when recipients are set', async () => {
    (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue([{ statusId: 1, count: 10 }]);
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 2,
        reportId: 5,
        ownerStaffId: 7,
        cron: '*/5 * * * *',
        recipients: ['admin@example.com', 'manager@example.com'],
        isEnabled: true,
        format: 'csv',
        report: { id: 5, title: 'CSV Report', definition: VALID_DEFINITION },
      },
    ]);

    await processor.process(makeJob());

    expect(mail.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['admin@example.com', 'manager@example.com'],
        subject: expect.stringContaining('CSV Report'),
      }),
    );
  });

  // ─── Stores error in ReportRun on failure ─────────────────────────────────

  it('stores error in ReportRun when compiler throws', async () => {
    (compiler.compile as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection lost'));
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 3,
        reportId: 10,
        ownerStaffId: 7,
        cron: '0 9 * * 1',
        recipients: [],
        isEnabled: true,
        format: 'json',
        report: { id: 10, title: 'Erroring Report', definition: VALID_DEFINITION },
      },
    ]);

    await processor.process(makeJob());

    expect(prisma.reportRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: 'DB connection lost',
          rowCount: 0,
        }),
      }),
    );

    // Schedule should still be advanced despite error
    expect(prisma.reportSchedule.update).toHaveBeenCalled();
  });

  it('fails closed, does not send mail, and disables a legacy ownerless schedule', async () => {
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 30,
        reportId: 10,
        ownerStaffId: null,
        cron: '0 9 * * 1',
        recipients: ['recipient@example.com'],
        isEnabled: true,
        format: 'json',
        report: { id: 10, title: 'Legacy', definition: VALID_DEFINITION },
      },
    ]);

    await processor.process(makeJob());

    expect(compiler.compile).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.reportRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: expect.stringContaining('no owner'), rowCount: 0 }),
      }),
    );
    expect(prisma.reportSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 30 }, data: expect.objectContaining({ isEnabled: false }) }),
    );
  });

  it('fails closed and disables a schedule when its owner loses report.run', async () => {
    (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 7,
      isEnabled: true,
      staffGroup: { isAdmin: false, permissions: [] },
    });
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 31,
        reportId: 10,
        ownerStaffId: 7,
        cron: '0 9 * * 1',
        recipients: ['recipient@example.com'],
        isEnabled: true,
        format: 'json',
        report: { id: 10, title: 'Revoked', definition: VALID_DEFINITION },
      },
    ]);

    await processor.process(makeJob());

    expect(compiler.compile).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
    expect(prisma.reportSchedule.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 31 }, data: expect.objectContaining({ isEnabled: false }) }),
    );
  });

  // ─── Invalid definition → error stored ───────────────────────────────────

  it('stores parse error when report definition is invalid', async () => {
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 4,
        reportId: 20,
        ownerStaffId: 7,
        cron: '0 * * * *',
        recipients: [],
        isEnabled: true,
        format: 'json',
        report: { id: 20, title: 'Bad Def', definition: { source: 'INVALID_SOURCE' } },
      },
    ]);

    await processor.process(makeJob());

    expect(prisma.reportRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: expect.stringContaining('Invalid'),
        }),
      }),
    );
  });
});
