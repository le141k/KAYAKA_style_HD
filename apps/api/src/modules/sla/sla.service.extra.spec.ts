/**
 * Additional SLA service coverage: CRUD for schedules, holidays, plans, rules,
 * resolvePlanForTicket, and runPeriodicCheck.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SlaService } from './sla.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';

function makePrismaMock() {
  return {
    slaPlan: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    slaSchedule: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    slaHoliday: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    escalationRule: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    ticket: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    ticketNote: {
      create: vi.fn(),
    },
    organization: {
      findUnique: vi.fn(),
    },
    staff: {
      findUnique: vi.fn(),
    },
  } as unknown as PrismaService;
}

function makeMailMock() {
  return {
    send: vi.fn(),
    sendTemplate: vi.fn(),
    renderTemplate: vi.fn(),
  } as unknown as MailService;
}

const MOCK_PLAN = {
  id: 1,
  title: 'Standard SLA',
  isEnabled: true,
  criteria: {},
  firstResponseSeconds: 3600,
  resolutionSeconds: 86400,
  scheduleId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  escalationRules: [],
};

const MOCK_SCHEDULE = {
  id: 1,
  title: 'Business Hours',
  workHours: { mon: [['09:00', '18:00']], tue: [['09:00', '18:00']] },
  holidays: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_HOLIDAY = {
  id: 1,
  name: 'New Year',
  date: new Date('2025-01-01'),
  scheduleId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_RULE = {
  id: 1,
  slaPlanId: 1,
  name: 'Level 1 Escalation',
  targetType: 'FIRST_RESPONSE',
  thresholdSeconds: 3600,
  actions: [],
  isEnabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_TICKET = {
  id: 1,
  kayakoId: null,
  mask: 'TT-000001',
  subject: 'Test',
  dueAt: new Date(Date.now() - 60_000),
  resolutionDueAt: null,
  firstResponseAt: null,
  isResolved: false,
  isEscalated: false,
  slaPlanId: 1,
  ownerStaffId: null,
  escalationLevel: 0,
};

describe('SlaService (extra coverage)', () => {
  let service: SlaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let mail: MailService;

  beforeEach(() => {
    prisma = makePrismaMock();
    mail = makeMailMock();
    service = new SlaService(prisma as unknown as PrismaService, mail);
  });

  // ─── resolvePlanForTicket ─────────────────────────────────────────────────────

  describe('resolvePlanForTicket', () => {
    it('returns org-specific plan when organization has one', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ slaPlanId: 5 });

      const result = await service.resolvePlanForTicket(10);
      expect(result).toBe(5);
      expect(prisma.slaPlan.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to default plan when org has no dedicated plan', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ slaPlanId: null });
      (prisma.slaPlan.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 3 });

      const result = await service.resolvePlanForTicket(10);
      expect(result).toBe(3);
    });

    it('falls back to default plan when no organizationId given', async () => {
      (prisma.slaPlan.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 2 });

      const result = await service.resolvePlanForTicket(null);
      expect(result).toBe(2);
    });

    it('returns null when no plans are configured', async () => {
      (prisma.slaPlan.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      const result = await service.resolvePlanForTicket(null);
      expect(result).toBeNull();
    });
  });

  // ─── SlaSchedule CRUD ─────────────────────────────────────────────────────────

  describe('listSchedules', () => {
    it('returns all schedules with holidays', async () => {
      (prisma.slaSchedule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_SCHEDULE]);
      const result = await service.listSchedules();
      expect(result).toHaveLength(1);
      expect(prisma.slaSchedule.findMany).toHaveBeenCalledWith({ include: { holidays: true } });
    });
  });

  describe('getSchedule', () => {
    it('returns schedule when found', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SCHEDULE);
      const result = await service.getSchedule(1);
      expect(result.title).toBe('Business Hours');
    });

    it('throws NotFoundException when schedule not found', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getSchedule(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('createSchedule', () => {
    it('creates a new schedule', async () => {
      (prisma.slaSchedule.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SCHEDULE);
      const result = await service.createSchedule({ title: 'Business Hours', workHours: {} } as any);
      expect(result.title).toBe('Business Hours');
    });
  });

  describe('updateSchedule', () => {
    it('updates schedule when found', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SCHEDULE);
      (prisma.slaSchedule.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_SCHEDULE,
        title: 'Updated',
      });

      const result = await service.updateSchedule(1, { title: 'Updated' } as any);
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when schedule not found', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateSchedule(99, {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteSchedule', () => {
    it('deletes schedule when found', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SCHEDULE);
      (prisma.slaSchedule.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SCHEDULE);

      await service.deleteSchedule(1);
      expect(prisma.slaSchedule.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteSchedule(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── SlaHoliday CRUD ──────────────────────────────────────────────────────────

  describe('listHolidays', () => {
    it('returns holidays for a schedule', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SCHEDULE);
      (prisma.slaHoliday.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_HOLIDAY]);
      const result = await service.listHolidays(1);
      expect(result).toHaveLength(1);
    });
  });

  describe('createHoliday', () => {
    it('creates holiday for an existing schedule', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_SCHEDULE);
      (prisma.slaHoliday.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_HOLIDAY);

      const result = await service.createHoliday(1, {
        name: 'New Year',
        date: new Date('2025-01-01'),
      } as any);
      expect((result as any).name).toBe('New Year');
    });

    it('throws NotFoundException when schedule not found', async () => {
      (prisma.slaSchedule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.createHoliday(99, { name: 'Holiday', date: new Date() } as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateHoliday', () => {
    it('updates holiday when found', async () => {
      (prisma.slaHoliday.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_HOLIDAY);
      (prisma.slaHoliday.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_HOLIDAY,
        name: 'Updated',
      });

      const result = await service.updateHoliday(1, { name: 'Updated' } as any);
      expect((result as any).name).toBe('Updated');
    });

    it('throws NotFoundException when holiday not found', async () => {
      (prisma.slaHoliday.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateHoliday(99, {} as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteHoliday', () => {
    it('deletes holiday when found', async () => {
      (prisma.slaHoliday.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_HOLIDAY);
      (prisma.slaHoliday.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_HOLIDAY);

      await service.deleteHoliday(1);
      expect(prisma.slaHoliday.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when holiday not found', async () => {
      (prisma.slaHoliday.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteHoliday(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── SlaPlan CRUD ─────────────────────────────────────────────────────────────

  describe('listPlans', () => {
    it('returns all plans with escalation rules', async () => {
      (prisma.slaPlan.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_PLAN]);
      const result = await service.listPlans();
      expect(result).toHaveLength(1);
    });
  });

  describe('getPlan', () => {
    it('returns plan when found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PLAN);
      const result = await service.getPlan(1);
      expect(result.title).toBe('Standard SLA');
    });

    it('throws NotFoundException when plan not found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getPlan(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('createPlan', () => {
    it('creates a new SLA plan', async () => {
      (prisma.slaPlan.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PLAN);
      const result = await service.createPlan({
        title: 'Standard SLA',
        isEnabled: true,
        criteria: {},
        firstResponseSeconds: 3600,
        resolutionSeconds: 86400,
      } as any);
      expect(result.title).toBe('Standard SLA');
    });
  });

  describe('updatePlan', () => {
    it('updates plan when found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PLAN);
      (prisma.slaPlan.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_PLAN,
        title: 'Updated',
      });

      const result = await service.updatePlan(1, { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when plan not found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updatePlan(99, { title: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deletePlan', () => {
    it('deletes plan when found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PLAN);
      (prisma.slaPlan.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PLAN);

      await service.deletePlan(1);
      expect(prisma.slaPlan.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when plan not found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deletePlan(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── EscalationRule CRUD ──────────────────────────────────────────────────────

  describe('listRules', () => {
    it('returns all rules for a plan', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PLAN);
      (prisma.escalationRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_RULE]);
      const result = await service.listRules(1);
      expect(result).toHaveLength(1);
    });
  });

  describe('getRule', () => {
    it('returns rule when found', async () => {
      (prisma.escalationRule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RULE);
      const result = await service.getRule(1);
      expect((result as any).name).toBe('Level 1 Escalation');
    });

    it('throws NotFoundException when rule not found', async () => {
      (prisma.escalationRule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getRule(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('createRule', () => {
    it('creates a rule for an existing plan', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_PLAN);
      (prisma.escalationRule.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RULE);

      const result = await service.createRule(1, {
        name: 'Level 1 Escalation',
        targetType: 'FIRST_RESPONSE',
        thresholdSeconds: 3600,
        actions: [],
        isEnabled: true,
      } as any);
      expect((result as any).name).toBe('Level 1 Escalation');
    });

    it('throws NotFoundException when plan not found', async () => {
      (prisma.slaPlan.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.createRule(99, { name: 'X', actions: [] } as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateRule', () => {
    it('updates rule when found', async () => {
      (prisma.escalationRule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RULE);
      (prisma.escalationRule.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_RULE,
        name: 'Updated',
      });

      const result = await service.updateRule(1, { name: 'Updated' });
      expect((result as any).name).toBe('Updated');
    });

    it('throws NotFoundException when rule not found', async () => {
      (prisma.escalationRule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateRule(99, { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteRule', () => {
    it('deletes rule when found', async () => {
      (prisma.escalationRule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RULE);
      (prisma.escalationRule.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_RULE);

      await service.deleteRule(1);
      expect(prisma.escalationRule.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when rule not found', async () => {
      (prisma.escalationRule.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteRule(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── runPeriodicCheck ─────────────────────────────────────────────────────────

  describe('runPeriodicCheck', () => {
    it('does nothing when there are no breaches', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await service.runPeriodicCheck();
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('marks ticket as escalated and executes escalation rules on breach', async () => {
      const breachedTicket = {
        ...MOCK_TICKET,
        dueAt: new Date(Date.now() - 120 * 60_000), // 2 hours overdue
        firstResponseAt: null,
        isEscalated: false,
        slaPlanId: 1,
      };

      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([breachedTicket]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.escalationRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.runPeriodicCheck();

      // Should mark as escalated
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ isEscalated: true }),
        }),
      );
    });

    it('does not double-escalate already escalated tickets', async () => {
      const alreadyEscalated = {
        ...MOCK_TICKET,
        dueAt: new Date(Date.now() - 120 * 60_000),
        firstResponseAt: null,
        isEscalated: true,
        slaPlanId: null, // no plan, so no rule execution
      };

      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([alreadyEscalated]);

      await service.runPeriodicCheck();

      // Should NOT call ticket.update for escalation mark (already escalated)
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });
  });
});
