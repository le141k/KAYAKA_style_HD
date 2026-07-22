import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportScheduleProcessor } from './report-schedule.processor';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import type { ReportCompiler } from './report-compiler';

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePrismaMock() {
  // reportRun and reportSchedule fields are migration-backed in production;
  // cast as any since generated PrismaClient types may not reflect local migration yet.
  const reportSchedule = {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const reportRun = {
    create: vi.fn().mockResolvedValue({ id: 1 }),
  };
  const staff = {
    findUnique: vi.fn().mockResolvedValue({
      id: 7,
      isEnabled: true,
      staffGroup: { isAdmin: false, permissions: ['report.run'] },
      departments: [{ departmentId: 2 }, { departmentId: 1 }],
    }),
  };
  const tx = {
    reportSchedule,
    reportRun,
    // Separate mock lets a barrier test change authorization after compilation
    // but before the persistence transaction re-reads it.
    staff: {
      findUnique: vi.fn().mockResolvedValue({
        id: 7,
        isEnabled: true,
        staffGroup: { isAdmin: false, permissions: ['report.run'] },
        departments: [{ departmentId: 1 }, { departmentId: 2 }],
      }),
    },
  };
  return {
    reportSchedule,
    // New model added by migration
    reportRun,
    staff,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    __tx: tx,
  } as unknown as PrismaService;
}

function makeCompilerMock() {
  return {
    compile: vi.fn().mockResolvedValue([]),
  } as unknown as ReportCompiler;
}

function makeMailMock() {
  return {
    createReportEmail: vi.fn().mockResolvedValue({ id: 'report-outbox-1' }),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
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

    expect(prisma.reportSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 7, isEnabled: true }),
        data: expect.objectContaining({
          lastRunAt: expect.any(Date),
          nextRunAt: expect.any(Date),
        }),
      }),
    );
  });

  // ─── Sends email when recipients present ─────────────────────────────────

  it('creates a durable REPORT outbox command when recipients are set', async () => {
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

    expect(mail.createReportEmail).toHaveBeenCalledWith(
      (prisma as unknown as { __tx: unknown }).__tx,
      expect.objectContaining({
        to: ['admin@example.com', 'manager@example.com'],
        subject: expect.stringContaining('CSV Report'),
        text: expect.stringContaining('statusId,count'),
      }),
    );
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('report-outbox-1');
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('keeps a committed report command durable when the Redis wake-up fails', async () => {
    (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue([{ statusId: 1, count: 10 }]);
    (mail.enqueueOutbound as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('redis unavailable'));
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 22,
        reportId: 5,
        ownerStaffId: 7,
        cron: '*/5 * * * *',
        recipients: ['admin@example.com'],
        isEnabled: true,
        format: 'json',
        report: { id: 5, title: 'JSON Report', definition: VALID_DEFINITION },
      },
    ]);

    await expect(processor.process(makeJob())).resolves.toBeUndefined();
    await Promise.resolve(); // detached durable-wake-up diagnostic

    expect(prisma.reportRun.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: null }) }),
    );
    expect(prisma.reportSchedule.updateMany).toHaveBeenCalledTimes(1);
    expect(mail.createReportEmail).toHaveBeenCalledTimes(1);
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('does not create a second ReportRun or email when another scanner wins the due CAS', async () => {
    (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue([{ statusId: 1, count: 10 }]);
    (prisma.reportSchedule.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 23,
        reportId: 5,
        ownerStaffId: 7,
        cron: '*/5 * * * *',
        recipients: ['admin@example.com'],
        isEnabled: true,
        format: 'json',
        report: { id: 5, title: 'Contended Report', definition: VALID_DEFINITION },
      },
    ]);

    await processor.process(makeJob());

    expect(prisma.reportRun.create).not.toHaveBeenCalled();
    expect(mail.createReportEmail).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
  });

  it('rejects a compiled snapshot when schedule/report generations or the exact fire changed', async () => {
    const dueAt = new Date('2026-07-22T09:55:00.000Z');
    (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue([{ statusId: 1, count: 10 }]);
    // Simulates an operator editing recipients/owner/definition while the report
    // was compiling: their config write advances a generation before our tx CAS.
    (prisma.reportSchedule.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 24,
        reportId: 5,
        ownerStaffId: 7,
        cron: '*/5 * * * *',
        recipients: ['old-recipient@example.com'],
        isEnabled: true,
        format: 'json',
        configGeneration: 12,
        nextRunAt: dueAt,
        report: { id: 5, title: 'Edited Report', definition: VALID_DEFINITION, configGeneration: 34 },
      },
    ]);

    await processor.process(makeJob());

    expect(prisma.reportSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 24,
          reportId: 5,
          ownerStaffId: 7,
          isEnabled: true,
          nextRunAt: dueAt,
          configGeneration: 12,
          report: { is: { id: 5, configGeneration: 34 } },
        },
      }),
    );
    expect(prisma.reportRun.create).not.toHaveBeenCalled();
    expect(mail.createReportEmail).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
  });

  it('revalidates owner authorization after compilation and commits nothing after a revocation', async () => {
    const dueAt = new Date('2026-07-22T09:55:00.000Z');
    let releaseCompile!: (rows: Array<Record<string, unknown>>) => void;
    (compiler.compile as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<Array<Record<string, unknown>>>((resolve) => {
          releaseCompile = resolve;
        }),
    );
    (prisma.reportSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 25,
        reportId: 5,
        ownerStaffId: 7,
        cron: '*/5 * * * *',
        recipients: ['recipient@example.com'],
        isEnabled: true,
        format: 'json',
        configGeneration: 3,
        nextRunAt: dueAt,
        report: { id: 5, title: 'Authorization barrier', definition: VALID_DEFINITION, configGeneration: 4 },
      },
    ]);

    const processing = processor.process(makeJob());
    await vi.waitFor(() => expect(compiler.compile).toHaveBeenCalledTimes(1));

    // Barrier: report compilation has already consumed the former department
    // scope; revoke the owner before the short persistence transaction starts.
    const tx = (
      prisma as unknown as {
        __tx: { staff: { findUnique: ReturnType<typeof vi.fn> } };
      }
    ).__tx;
    tx.staff.findUnique.mockResolvedValue({
      id: 7,
      isEnabled: false,
      staffGroup: { isAdmin: false, permissions: ['report.run'] },
      departments: [{ departmentId: 1 }],
    });
    releaseCompile([{ count: 10 }]);

    await processing;

    expect(tx.staff.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(prisma.reportSchedule.updateMany).not.toHaveBeenCalled();
    expect(prisma.reportRun.create).not.toHaveBeenCalled();
    expect(mail.createReportEmail).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
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

    // The error row and the next scheduled fire are committed atomically.
    expect(prisma.reportSchedule.updateMany).toHaveBeenCalled();
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
    expect(mail.createReportEmail).not.toHaveBeenCalled();
    expect(prisma.reportRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ error: expect.stringContaining('no owner'), rowCount: 0 }),
      }),
    );
    expect(prisma.reportSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 30 }),
        data: expect.objectContaining({ isEnabled: false }),
      }),
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
    expect(mail.createReportEmail).not.toHaveBeenCalled();
    expect(prisma.reportSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 31 }),
        data: expect.objectContaining({ isEnabled: false }),
      }),
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
