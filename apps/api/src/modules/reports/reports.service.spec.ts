import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportCompiler } from './report-compiler';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthStaff } from '../../auth/auth.decorators';
import type { TicketAccessPolicy } from '../tickets/ticket-access-policy.service';

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
      findFirst: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
}

function makeCompilerMock() {
  return {
    compile: vi.fn().mockResolvedValue([]),
  } as unknown as ReportCompiler;
}

function makeTicketAccessMock() {
  return {
    ticketWhere: vi.fn().mockResolvedValue({ departmentId: { in: [1] } }),
    resolveScope: vi.fn().mockResolvedValue({ unrestricted: false, departmentIds: [1] }),
    ticketWhereForScope: vi.fn().mockReturnValue({ departmentId: { in: [1] } }),
  } as unknown as TicketAccessPolicy;
}

const REPORT_RUNNER: AuthStaff = {
  staffId: 7,
  email: 'agent-a@example.test',
  isAdmin: false,
  permissions: ['report.run'],
};

const REPORT_MANAGER: AuthStaff = {
  ...REPORT_RUNNER,
  permissions: ['report.run', 'report.manage'],
};

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let compiler: ReturnType<typeof makeCompilerMock>;
  let ticketAccess: ReturnType<typeof makeTicketAccessMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    compiler = makeCompilerMock();
    ticketAccess = makeTicketAccessMock();
    service = new ReportsService(
      prisma as unknown as PrismaService,
      compiler as unknown as ReportCompiler,
      ticketAccess,
    );
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

      const result = await service.run(1, REPORT_RUNNER);
      expect(result).toEqual(mockRows);
      expect(compiler.compile).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'tickets' }),
        REPORT_RUNNER,
      );
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

      await service.run(2, REPORT_RUNNER);

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

      await expect(service.run(99, REPORT_RUNNER)).rejects.toThrow(BadRequestException);
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

      const result = await service.dashboard(REPORT_RUNNER);

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

      await service.dashboard(REPORT_RUNNER);

      const groupByCalls = (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mock.calls;
      const groupByFields = groupByCalls.map((call: unknown[]) => (call[0] as { by: string[] }).by[0]);
      expect(groupByFields).toContain('statusId');
      expect(groupByFields).toContain('priorityId');
    });

    it('keeps every aggregate query inside the caller department predicate', async () => {
      await service.dashboard(REPORT_RUNNER);

      for (const call of (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mock.calls) {
        expect(call[0].where).toEqual({
          AND: [{ mergedIntoId: null }, { departmentId: { in: [1] } }],
        });
      }
      expect((prisma.ticket.count as ReturnType<typeof vi.fn>).mock.calls[0]![0].where).toEqual({
        AND: [{ mergedIntoId: null }, { departmentId: { in: [1] } }],
      });
      const rawAverageCall = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const rawDepartmentClause = rawAverageCall[1] as { strings: string[]; values: unknown[] };
      expect(rawDepartmentClause.strings.join('')).toContain('"departmentId" IN');
      expect(rawDepartmentClause.values).toContain(1);
      expect(ticketAccess.resolveScope).toHaveBeenCalledWith(REPORT_RUNNER);
    });

    it('returns 0 avgFirstResponseMinutes when no responded tickets', async () => {
      (prisma.ticket.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ avg_minutes: null }]);

      const result = await service.dashboard(REPORT_RUNNER);
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
      const res = (await service.createSchedule(
        7,
        {
          cron: '*/5 * * * *',
          recipients: [],
          isEnabled: true,
          format: 'json',
        },
        REPORT_MANAGER,
      )) as { nextRunAt: Date; ownerStaffId: number };

      expect(res.nextRunAt).toBeInstanceOf(Date);
      // Next */5 fire is in the future (never NULL → the `nextRunAt <= now` scan works).
      expect(res.nextRunAt.getTime()).toBeGreaterThan(before);
      expect(res.ownerStaffId).toBe(REPORT_MANAGER.staffId);
    });

    it('refuses an owner who can manage definitions but cannot run their scheduled report', async () => {
      await expect(
        service.createSchedule(
          7,
          { cron: '*/5 * * * *', recipients: [], isEnabled: true, format: 'json' },
          { ...REPORT_MANAGER, permissions: ['report.manage'] },
        ),
      ).rejects.toThrow('report.run');
      expect(prisma.reportSchedule.create).not.toHaveBeenCalled();
    });
  });

  describe('schedule ownership', () => {
    it("hides another manager's schedule and refuses to mutate it", async () => {
      await expect(service.updateSchedule(44, { isEnabled: false }, REPORT_MANAGER)).rejects.toThrow(
        'Report schedule not found',
      );
      expect(prisma.reportSchedule.update).not.toHaveBeenCalled();
      expect(prisma.reportSchedule.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 44, ownerStaffId: REPORT_MANAGER.staffId } }),
      );
    });

    it('scopes non-admin schedule lists to the owner', async () => {
      await service.listSchedules(7, REPORT_MANAGER);
      expect(prisma.reportSchedule.findMany).toHaveBeenCalledWith({
        where: { reportId: 7, ownerStaffId: REPORT_MANAGER.staffId },
      });
    });

    it('updates an owned schedule through an owner-qualified mutation', async () => {
      (prisma.reportSchedule.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.reportSchedule.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 44,
        isEnabled: false,
      });

      await expect(service.updateSchedule(44, { isEnabled: false }, REPORT_MANAGER)).resolves.toEqual({
        id: 44,
        isEnabled: false,
      });
      expect(prisma.reportSchedule.updateMany).toHaveBeenCalledWith({
        where: { id: 44, ownerStaffId: REPORT_MANAGER.staffId },
        data: { isEnabled: false },
      });
      expect(prisma.reportSchedule.update).not.toHaveBeenCalled();
    });

    it('uses an owner-qualified DELETE predicate instead of a check-then-unscoped delete', async () => {
      (prisma.reportSchedule.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 44 });
      await expect(service.removeSchedule(44, REPORT_MANAGER)).rejects.toThrow('Report schedule not found');
      expect(prisma.reportSchedule.delete).not.toHaveBeenCalled();
      expect(prisma.reportSchedule.deleteMany).toHaveBeenCalledWith({
        where: { id: 44, ownerStaffId: REPORT_MANAGER.staffId },
      });
    });
  });
});
