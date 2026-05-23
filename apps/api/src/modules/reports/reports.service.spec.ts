import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportCompiler } from './report-compiler';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── Mock factories ───────────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    report: {
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ticket: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // avg first-response is computed DB-side via $queryRaw (no unbounded findMany)
    $queryRaw: vi.fn().mockResolvedValue([{ avg_minutes: null }]),
    // These are new Prisma models added by our migration; cast as any
    reportRun: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    reportSchedule: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

function makeCompilerMock() {
  return {
    compile: vi.fn().mockResolvedValue([]),
  } as unknown as ReportCompiler;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let compiler: ReturnType<typeof makeCompilerMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    compiler = makeCompilerMock();
    service = new ReportsService(prisma as unknown as PrismaService, compiler as unknown as ReportCompiler);
  });

  // ─── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns all reports ordered by createdAt desc', async () => {
      const reports = [{ id: 1, title: 'Report 1' }];
      (prisma.report.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(reports);

      const result = await service.list();
      expect(result).toHaveLength(1);
      expect(prisma.report.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
    });
  });

  // ─── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a new report with valid definition', async () => {
      const reportData = {
        title: 'Ticket Count',
        kind: 'SUMMARY' as const,
        definition: {
          source: 'tickets' as const,
          filters: [],
          groupBy: [],
          aggregates: [{ func: 'count' as const }],
          limit: 100,
        },
      };
      (prisma.report.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1, ...reportData });

      const result = await service.create(reportData);
      expect(result.id).toBe(1);
      expect(prisma.report.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: 'Ticket Count', kind: 'SUMMARY' }),
        }),
      );
    });

    it('throws BadRequestException for invalid definition', async () => {
      const reportData = {
        title: 'Bad Report',
        kind: 'SUMMARY' as const,
        definition: { source: 'UNKNOWN_SOURCE' } as unknown as never,
      };
      await expect(service.create(reportData)).rejects.toThrow(BadRequestException);
    });
  });

  // ─── run ─────────────────────────────────────────────────────────────────────

  describe('run', () => {
    it('loads stored report and executes via compiler', async () => {
      const mockRows = [{ statusId: 1, count: 5 }];
      (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue(mockRows);
      (prisma.report.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        definition: {
          source: 'tickets',
          filters: [],
          groupBy: ['statusId'],
          aggregates: [{ func: 'count' }],
          limit: 100,
        },
      });

      const result = await service.run(1);
      expect(result).toEqual(mockRows);
      expect(compiler.compile).toHaveBeenCalledTimes(1);
    });

    it('creates a ReportRun record', async () => {
      (compiler.compile as ReturnType<typeof vi.fn>).mockResolvedValue([{ count: 10 }]);
      (prisma.report.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 2,
        definition: {
          source: 'tickets',
          filters: [],
          groupBy: [],
          aggregates: [{ func: 'count' }],
          limit: 100,
        },
      });

      await service.run(2, 'manual', 7);

      expect(prisma.reportRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reportId: 2,
            triggeredBy: 'manual',
            staffId: 7,
            rowCount: 1,
          }),
        }),
      );
    });

    it('re-parses stored definition through schema (injection-safe)', async () => {
      // A definition that looks injection-y but is re-validated
      (prisma.report.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 99,
        definition: { source: 'DROP TABLE tickets' },
      });

      await expect(service.run(99)).rejects.toThrow(BadRequestException);
      // Compiler should NOT have been called
      expect(compiler.compile).not.toHaveBeenCalled();
    });
  });

  // ─── dashboard ───────────────────────────────────────────────────────────────

  describe('dashboard', () => {
    it('returns combined dashboard metrics', async () => {
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
        { statusId: 1, _count: { _all: 10 } },
      ]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(100) // total
        .mockResolvedValueOnce(40) // resolved
        .mockResolvedValueOnce(5); // slaBreached
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ avg_minutes: 30 }]);

      const result = await service.dashboard();

      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('resolved');
      expect(result).toHaveProperty('slaBreached', 5);
      expect(result).toHaveProperty('avgFirstResponseMinutes', 30);
      expect(result).toHaveProperty('byStatus');
      expect(result).toHaveProperty('byPriority');
    });

    it('executes groupBy for both statusId and priorityId', async () => {
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.dashboard();

      const groupByCalls = (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mock.calls;
      const groupByFields = groupByCalls.map((call: unknown[]) => (call[0] as { by: string[] }).by[0]);
      expect(groupByFields).toContain('statusId');
      expect(groupByFields).toContain('priorityId');
    });

    it('returns 0 avgFirstResponseMinutes when no responded tickets', async () => {
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ avg_minutes: null }]);

      const result = await service.dashboard();
      expect(result.avgFirstResponseMinutes).toBe(0);
    });
  });

  // ─── listRuns ─────────────────────────────────────────────────────────────

  describe('listRuns', () => {
    it('returns run history for a report', async () => {
      const runs = [{ id: 1, reportId: 5, rowCount: 10 }];
      (prisma.reportRun.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(runs);

      const result = await service.listRuns(5);
      expect(result).toEqual(runs);
      expect(prisma.reportRun.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { reportId: 5 } }),
      );
    });
  });

  describe('createSchedule', () => {
    it('seeds a non-NULL nextRunAt from the cron (so the processor can pick it up)', async () => {
      (prisma.reportSchedule.create as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) => ({
        id: 1,
        ...(args as { data: Record<string, unknown> }).data,
      }));

      const before = Date.now();
      const res = (await service.createSchedule(7, {
        cron: '*/5 * * * *',
        recipients: [],
        isEnabled: true,
        format: 'json',
      })) as { nextRunAt: Date };

      expect(res.nextRunAt).toBeInstanceOf(Date);
      // Next */5 fire is in the future (never NULL → the `nextRunAt <= now` scan works).
      expect(res.nextRunAt.getTime()).toBeGreaterThan(before);
    });
  });
});
