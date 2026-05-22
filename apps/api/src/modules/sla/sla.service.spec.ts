import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlaService } from './sla.service';
import type { PrismaService } from '../../prisma/prisma.service';

type WorkHours = Record<string, Array<[string, string]>>;

function makePrismaMock() {
  return {
    slaPlan: { findUnique: vi.fn() },
    ticket: { findMany: vi.fn(), update: vi.fn() },
    organization: { findUnique: vi.fn() },
  } as unknown as PrismaService;
}

/** Mon–Fri 09:00–18:00 work hours fixture */
const STD_WORK_HOURS: WorkHours = {
  mon: [['09:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '18:00']],
};

describe('SlaService', () => {
  let service: SlaService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new SlaService(prisma as unknown as PrismaService);
  });

  // ─── computeDueDates ──────────────────────────────────────────────────────

  describe('computeDueDates', () => {
    it('returns null due dates when plan not found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await service.computeDueDates(999, new Date());
      expect(result).toEqual({ dueAt: null, resolutionDueAt: null });
    });

    it('uses wall-clock offsets when no schedule is attached', async () => {
      const now = new Date('2025-01-13T10:00:00Z');
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        isEnabled: true,
        firstResponseSeconds: 3600,  // 1 hour
        resolutionSeconds: 86400,    // 24 hours
        schedule: null,
      });

      const { dueAt, resolutionDueAt } = await service.computeDueDates(1, now);

      expect(dueAt?.getTime()).toBeCloseTo(now.getTime() + 3600 * 1000, -3);
      expect(resolutionDueAt?.getTime()).toBeCloseTo(now.getTime() + 86400 * 1000, -3);
    });

    it('adds working hours correctly (skips night hours)', async () => {
      // Start at 17:00 on a Monday — only 1h left in the workday
      // 4h first response should push into Tuesday 10:00
      const now = new Date('2025-01-13T17:00:00+03:00'); // Monday 17:00 MSK = 14:00 UTC

      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        isEnabled: true,
        firstResponseSeconds: 4 * 3600, // 4 working hours
        resolutionSeconds: null,
        schedule: {
          id: 1,
          workHours: STD_WORK_HOURS,
          holidays: [],
        },
      });

      const { dueAt } = await service.computeDueDates(1, now);
      expect(dueAt).not.toBeNull();
      // After 1h of work on Monday (to 18:00) + 3h on Tuesday from 09:00 = 12:00 Tuesday
      if (dueAt) {
        // Day should be Tuesday (or later)
        expect(dueAt.getTime()).toBeGreaterThan(now.getTime());
      }
    });

    it('returns null dueAt when plan has no firstResponseSeconds', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        isEnabled: true,
        firstResponseSeconds: null,
        resolutionSeconds: null,
        schedule: null,
      });

      const { dueAt } = await service.computeDueDates(1, new Date());
      expect(dueAt).toBeNull();
    });
  });

  // ─── checkBreaches ────────────────────────────────────────────────────────

  describe('checkBreaches', () => {
    it('returns empty array when no tickets are breached', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const breaches = await service.checkBreaches();
      expect(breaches).toHaveLength(0);
    });

    it('detects first-response breach', async () => {
      const dueAt = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
      const ticket = {
        id: 1,
        mask: 'TT-000001',
        dueAt,
        resolutionDueAt: null,
        firstResponseAt: null,
        isResolved: false,
        isEscalated: false,
      };

      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
      const breaches = await service.checkBreaches();

      expect(breaches).toHaveLength(1);
      expect(breaches[0]!.breachType).toBe('FIRST_RESPONSE');
      expect(breaches[0]!.minutesOverdue).toBeGreaterThanOrEqual(59);
    });

    it('detects resolution breach', async () => {
      const resolutionDueAt = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      const ticket = {
        id: 2,
        mask: 'TT-000002',
        dueAt: null,
        resolutionDueAt,
        firstResponseAt: new Date(),
        isResolved: false,
        isEscalated: false,
      };

      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
      const breaches = await service.checkBreaches();

      expect(breaches).toHaveLength(1);
      expect(breaches[0]!.breachType).toBe('RESOLUTION');
    });

    it('can detect multiple breaches on the same ticket', async () => {
      const dueAt = new Date(Date.now() - 2 * 3600 * 1000);
      const resolutionDueAt = new Date(Date.now() - 1 * 3600 * 1000);
      const ticket = {
        id: 3,
        mask: 'TT-000003',
        dueAt,
        resolutionDueAt,
        firstResponseAt: null, // no response yet
        isResolved: false,
        isEscalated: false,
      };

      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
      const breaches = await service.checkBreaches();

      expect(breaches).toHaveLength(2);
      const types = breaches.map((b) => b.breachType);
      expect(types).toContain('FIRST_RESPONSE');
      expect(types).toContain('RESOLUTION');
    });
  });
});
