import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReportsService } from './reports.module';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    report: {
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
    },
    ticket: {
      groupBy: vi.fn(),
      count: vi.fn(),
    },
  } as unknown as PrismaService;
}

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new ReportsService(prisma as unknown as PrismaService);
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
    it('creates a new report with definition', async () => {
      const reportData = {
        title: 'Ticket Count',
        kind: 'SUMMARY' as const,
        definition: { source: 'tickets' as const, filters: {}, metric: 'count' as const },
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
  });

  // ─── execute ─────────────────────────────────────────────────────────────────

  describe('execute', () => {
    it('groups by field when groupBy is specified', async () => {
      const groupByRows = [
        { statusId: 1, _count: { _all: 5 } },
        { statusId: 2, _count: { _all: 3 } },
      ];
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue(groupByRows);

      const result = await service.execute({
        source: 'tickets',
        groupBy: 'statusId',
        filters: {},
        metric: 'count',
      });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ key: 1, count: 5 });
      expect(result[1]).toEqual({ key: 2, count: 3 });
      expect(prisma.ticket.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['statusId'], _count: { _all: true } }),
      );
    });

    it('returns total count when no groupBy', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(42);

      const result = await service.execute({
        source: 'tickets',
        filters: {},
        metric: 'count',
      });

      expect(result).toEqual([{ key: 'total', count: 42 }]);
      expect(prisma.ticket.count).toHaveBeenCalled();
    });

    it('passes filters as where clause', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(10);

      await service.execute({
        source: 'tickets',
        filters: { isResolved: false },
        metric: 'count',
      });

      expect(prisma.ticket.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: { isResolved: false } }),
      );
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
        .mockResolvedValueOnce(40); // resolved

      const result = await service.dashboard();

      expect(result).toHaveProperty('total');
      expect(result).toHaveProperty('resolved');
      expect(result).toHaveProperty('byStatus');
      expect(result).toHaveProperty('byPriority');
    });

    it('executes groupBy for both statusId and priorityId', async () => {
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.dashboard();

      const groupByCalls = (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mock.calls;
      const groupByFields = groupByCalls.map((call: any[]) => call[0].by[0]);
      expect(groupByFields).toContain('statusId');
      expect(groupByFields).toContain('priorityId');
    });
  });

  // ─── run ─────────────────────────────────────────────────────────────────────

  describe('run', () => {
    it('loads stored report and executes its definition', async () => {
      (prisma.report.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        definition: { source: 'tickets', filters: {}, metric: 'count' },
      });
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(77);

      const result = await service.run(1);
      expect(result).toEqual([{ key: 'total', count: 77 }]);
    });
  });
});
