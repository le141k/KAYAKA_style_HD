import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ReportCompiler, buildWhere } from './report-compiler';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ReportDefinition } from './report-definition.schema';

// ─── Prisma mock factory ───────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    ticket: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ticketPost: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ticketAuditLog: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaService;
}

// ─── buildWhere tests ─────────────────────────────────────────────────────────

describe('buildWhere', () => {
  it('throws BadRequestException for non-whitelisted filter field', () => {
    expect(() => buildWhere([{ field: 'DROP TABLE tickets', op: 'eq', value: 1 }], 'tickets')).toThrowError(
      BadRequestException,
    );
  });

  it('allows whitelisted eq filter', () => {
    const where = buildWhere([{ field: 'statusId', op: 'eq', value: 2 }], 'tickets');
    expect(where).toEqual({ statusId: 2 });
  });

  it('allows neq filter', () => {
    const where = buildWhere([{ field: 'isResolved', op: 'neq', value: true }], 'tickets');
    expect(where).toEqual({ isResolved: { not: true } });
  });

  it('allows in filter', () => {
    const where = buildWhere([{ field: 'priorityId', op: 'in', value: [1, 2, 3] }], 'tickets');
    expect(where).toEqual({ priorityId: { in: [1, 2, 3] } });
  });

  it('allows notIn filter', () => {
    const where = buildWhere([{ field: 'priorityId', op: 'notIn', value: [4] }], 'tickets');
    expect(where).toEqual({ priorityId: { notIn: [4] } });
  });

  it('resolves relative date token in gte filter', () => {
    const where = buildWhere([{ field: 'createdAt', op: 'gte', value: 'today' }], 'tickets');
    expect(where).toHaveProperty('createdAt.gte');
    expect((where.createdAt as { gte: Date }).gte).toBeInstanceOf(Date);
  });

  it('resolves absolute ISO date in lte filter', () => {
    const where = buildWhere(
      [{ field: 'createdAt', op: 'lte', value: '2026-01-01T00:00:00.000Z' }],
      'tickets',
    );
    expect(where).toHaveProperty('createdAt.lte');
    expect((where.createdAt as { lte: Date }).lte).toBeInstanceOf(Date);
  });

  it('resolves between filter with relative tokens', () => {
    const where = buildWhere(
      [{ field: 'createdAt', op: 'between', from: 'lastMonth', to: 'thisMonth' }],
      'tickets',
    );
    expect(where).toHaveProperty('createdAt.gte');
    expect(where).toHaveProperty('createdAt.lt');
  });

  it('rejects filter field not allowed for ticketPosts source', () => {
    expect(() => buildWhere([{ field: 'ownerStaffId', op: 'eq', value: 1 }], 'ticketPosts')).toThrowError(
      BadRequestException,
    );
  });

  it('builds multi-filter where correctly', () => {
    const where = buildWhere(
      [
        { field: 'isResolved', op: 'eq', value: false },
        { field: 'priorityId', op: 'in', value: [2, 3] },
      ],
      'tickets',
    );
    expect(where.isResolved).toBe(false);
    expect(where.priorityId).toEqual({ in: [2, 3] });
  });
});

// ─── ReportCompiler tests ─────────────────────────────────────────────────────

describe('ReportCompiler', () => {
  let compiler: ReportCompiler;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    compiler = new ReportCompiler(prisma as unknown as PrismaService);
  });

  // ─── count groupBy → prisma.groupBy fast path ────────────────────────────

  describe('count + pure column → prisma.groupBy fast path', () => {
    it('uses prisma.groupBy for count with statusId groupBy', async () => {
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
        { statusId: 1, _count: { _all: 10 } },
        { statusId: 2, _count: { _all: 5 } },
      ]);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: ['statusId'],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);

      expect(prisma.ticket.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['statusId'], _count: { _all: true } }),
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({ statusId: 1, count: 10 });
      expect(rows[1]).toEqual({ statusId: 2, count: 5 });
    });

    it('returns total count when no groupBy', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(42);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: [],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);
      expect(rows).toEqual([{ count: 42 }]);
      expect(prisma.ticket.count).toHaveBeenCalled();
    });
  });

  // ─── date-bucket JS path ─────────────────────────────────────────────────

  describe('date-bucket → JS grouping', () => {
    it('groups by createdAt:day using findMany + JS', async () => {
      const t1 = new Date('2026-01-15T10:00:00Z');
      const t2 = new Date('2026-01-15T14:00:00Z');
      const t3 = new Date('2026-01-16T09:00:00Z');

      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, createdAt: t1 },
        { id: 2, createdAt: t2 },
        { id: 3, createdAt: t3 },
      ]);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: ['createdAt:day'],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);

      // Should NOT call groupBy
      expect(prisma.ticket.groupBy).not.toHaveBeenCalled();
      expect(prisma.ticket.findMany).toHaveBeenCalled();
      expect(rows).toHaveLength(2);

      const jan15 = rows.find((r) => r['createdAt:day'] === '2026-01-15');
      const jan16 = rows.find((r) => r['createdAt:day'] === '2026-01-16');
      expect(jan15?.count).toBe(2);
      expect(jan16?.count).toBe(1);
    });

    it('groups by createdAt:month', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, createdAt: new Date('2026-01-10T00:00:00Z') },
        { id: 2, createdAt: new Date('2026-01-20T00:00:00Z') },
        { id: 3, createdAt: new Date('2026-02-05T00:00:00Z') },
      ]);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: ['createdAt:month'],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);
      expect(rows).toHaveLength(2);
      const jan = rows.find((r) => r['createdAt:month'] === '2026-01');
      expect(jan?.count).toBe(2);
    });
  });

  // ─── avg computed fields ─────────────────────────────────────────────────

  describe('avg on computed firstResponseSeconds', () => {
    it('computes avg firstResponseSeconds via JS', async () => {
      const createdAt = new Date('2026-01-01T08:00:00Z');
      const firstResponseAt1 = new Date('2026-01-01T09:00:00Z'); // 3600s
      const firstResponseAt2 = new Date('2026-01-01T10:00:00Z'); // 7200s

      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, createdAt, firstResponseAt: firstResponseAt1 },
        { id: 2, createdAt, firstResponseAt: firstResponseAt2 },
      ]);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: [],
        aggregates: [{ func: 'avg', field: 'firstResponseSeconds', alias: 'avgResponse' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveProperty('avgResponse');
      // avg of 3600 and 7200 = 5400
      expect(rows[0]!.avgResponse).toBe(5400);
    });

    it('computes avg resolutionSeconds via JS', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 1,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          resolvedAt: new Date('2026-01-01T01:00:00Z'), // 3600s
        },
      ]);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: [],
        aggregates: [{ func: 'avg', field: 'resolutionSeconds', alias: 'avgResolution' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);
      expect(rows[0]!.avgResolution).toBe(3600);
    });
  });

  // ─── multi-groupBy ───────────────────────────────────────────────────────

  describe('multi-groupBy', () => {
    it('groups by two pure columns using prisma.groupBy', async () => {
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
        { departmentId: 1, statusId: 1, _count: { _all: 3 } },
        { departmentId: 1, statusId: 2, _count: { _all: 7 } },
      ]);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: ['departmentId', 'statusId'],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);
      expect(prisma.ticket.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({ by: ['departmentId', 'statusId'] }),
      );
      expect(rows[0]).toEqual({ departmentId: 1, statusId: 1, count: 3 });
    });

    it('groups by date bucket + pure column via JS', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, createdAt: new Date('2026-01-15T00:00:00Z'), statusId: 1 },
        { id: 2, createdAt: new Date('2026-01-15T00:00:00Z'), statusId: 2 },
        { id: 3, createdAt: new Date('2026-01-16T00:00:00Z'), statusId: 1 },
      ]);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: ['createdAt:day', 'statusId'],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);
      expect(rows).toHaveLength(3);
    });
  });

  // ─── limit ───────────────────────────────────────────────────────────────

  describe('limit', () => {
    it('slices results to the defined limit', async () => {
      const manyRows = Array.from({ length: 50 }, (_, i) => ({
        statusId: i,
        _count: { _all: 1 },
      }));
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue(manyRows);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        groupBy: ['statusId'],
        aggregates: [{ func: 'count' }],
        limit: 10,
      };

      const rows = await compiler.compile(def);
      expect(rows).toHaveLength(10);
    });
  });

  // ─── whitelist enforcement ────────────────────────────────────────────────

  describe('whitelist enforcement', () => {
    it('throws BadRequestException for invalid groupBy field', async () => {
      const def: ReportDefinition = {
        source: 'tickets',
        filters: [],
        // Force invalid by bypassing schema validation
        groupBy: ['INVALID_FIELD'] as unknown as string[],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };
      await expect(compiler.compile(def)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for invalid filter field in buildWhere', () => {
      expect(() => buildWhere([{ field: '__proto__', op: 'eq', value: 1 }], 'tickets')).toThrowError(
        BadRequestException,
      );
    });
  });

  // ─── ticketAuditLogs source ───────────────────────────────────────────────

  describe('ticketAuditLogs source', () => {
    it('groups by staffId and action using groupBy fast path', async () => {
      (prisma.ticketAuditLog.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
        { staffId: 1, action: 'REPLY', _count: { _all: 10 } },
      ]);

      const def: ReportDefinition = {
        source: 'ticketAuditLogs',
        filters: [{ field: 'actorType', op: 'eq', value: 'STAFF' }],
        groupBy: ['staffId', 'action'],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      const rows = await compiler.compile(def);
      expect(prisma.ticketAuditLog.groupBy).toHaveBeenCalled();
      expect(rows[0]).toEqual({ staffId: 1, action: 'REPLY', count: 10 });
    });
  });

  // ─── relative date in filter ─────────────────────────────────────────────

  describe('relative date filter', () => {
    it('translates thisMonth relative date to a date range in where clause', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);

      const def: ReportDefinition = {
        source: 'tickets',
        filters: [{ field: 'createdAt', op: 'gte', value: 'thisMonth' }],
        groupBy: [],
        aggregates: [{ func: 'count' }],
        limit: 100,
      };

      await compiler.compile(def);

      expect(prisma.ticket.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        }),
      );
    });
  });
});
