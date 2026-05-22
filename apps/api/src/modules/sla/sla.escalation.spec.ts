/**
 * Covers SlaService.runPeriodicCheck → executeEscalationRules → executeAction
 * for all action types: notify, change_priority, assign, add_note, mark_escalated.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    slaHoliday: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
    organization: { findUnique: vi.fn() },
    staff: { findUnique: vi.fn() },
  } as unknown as PrismaService;
}

function makeMailMock() {
  return {
    send: vi.fn(),
    sendTemplate: vi.fn(),
    renderTemplate: vi.fn(),
  } as unknown as MailService;
}

/** A full Ticket shape for breach scenarios */
function makeBreachedTicket(overrides = {}) {
  return {
    id: 1,
    mask: 'TT-000001',
    subject: 'Test',
    dueAt: new Date(Date.now() - 120 * 60_000), // 2h overdue
    resolutionDueAt: null,
    firstResponseAt: null,
    isResolved: false,
    isEscalated: false,
    slaPlanId: 1,
    ownerStaffId: null,
    escalationLevel: 0,
    ...overrides,
  };
}

describe('SlaService – escalation actions via runPeriodicCheck', () => {
  let service: SlaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let mail: MailService;

  beforeEach(() => {
    prisma = makePrismaMock();
    mail = makeMailMock();
    service = new SlaService(prisma as unknown as PrismaService, mail);
  });

  function setupBreach(ticket: object, actions: object[]) {
    (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
    (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.escalationRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        slaPlanId: 1,
        name: 'Test Rule',
        targetType: 'FIRST_RESPONSE',
        thresholdSeconds: 60,
        actions,
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
  }

  it('executes change_priority action', async () => {
    setupBreach(makeBreachedTicket(), [{ type: 'change_priority', priorityId: 1 }]);

    await service.runPeriodicCheck();

    // escalation mark + change_priority update
    const updateCalls = (prisma.ticket.update as ReturnType<typeof vi.fn>).mock.calls;
    const priorityCall = updateCalls.find((c: any[]) => c[0]?.data?.priorityId !== undefined);
    expect(priorityCall).toBeDefined();
    expect(priorityCall![0].data.priorityId).toBe(1);
  });

  it('executes assign action', async () => {
    setupBreach(makeBreachedTicket(), [{ type: 'assign', staffId: 7 }]);

    await service.runPeriodicCheck();

    const updateCalls = (prisma.ticket.update as ReturnType<typeof vi.fn>).mock.calls;
    const assignCall = updateCalls.find((c: any[]) => c[0]?.data?.ownerStaffId !== undefined);
    expect(assignCall).toBeDefined();
    expect(assignCall![0].data.ownerStaffId).toBe(7);
  });

  it('executes add_note action', async () => {
    setupBreach(makeBreachedTicket(), [{ type: 'add_note', note: 'Please review' }]);
    (prisma.ticketNote.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await service.runPeriodicCheck();

    expect(prisma.ticketNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ticketId: 1, contents: expect.stringContaining('Please review') }),
      }),
    );
  });

  it('executes mark_escalated action', async () => {
    setupBreach(makeBreachedTicket(), [{ type: 'mark_escalated' }]);

    await service.runPeriodicCheck();

    const updateCalls = (prisma.ticket.update as ReturnType<typeof vi.fn>).mock.calls;
    // There should be a call with isEscalated: true from mark_escalated (distinct from the initial escalation mark)
    const markCall = updateCalls.find(
      (c: any[]) => c[0]?.data?.isEscalated === true && c[0]?.data?.escalationLevel !== undefined,
    );
    expect(markCall).toBeDefined();
  });

  it('executes notify action with a staffId from the action', async () => {
    setupBreach(makeBreachedTicket(), [{ type: 'notify', staffId: 3 }]);
    (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: 'staff@example.com',
      firstName: 'Bob',
    });
    (mail.sendTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await service.runPeriodicCheck();

    expect(prisma.staff.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      select: { email: true, firstName: true },
    });
    expect(mail.sendTemplate).toHaveBeenCalledWith(
      'staff@example.com',
      'sla_breach_internal',
      'en',
      expect.objectContaining({ mask: 'TT-000001' }),
    );
  });

  it('executes notify action with ownerStaffId when action has no staffId', async () => {
    setupBreach(makeBreachedTicket({ ownerStaffId: 5 }), [{ type: 'notify' }]);
    (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      email: 'owner@example.com',
      firstName: 'Alice',
    });
    (mail.sendTemplate as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await service.runPeriodicCheck();

    expect(prisma.staff.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { email: true, firstName: true },
    });
  });

  it('skips notify action when no staffId and no ownerStaffId', async () => {
    setupBreach(makeBreachedTicket({ ownerStaffId: null }), [{ type: 'notify' }]);

    await service.runPeriodicCheck();

    expect(prisma.staff.findUnique).not.toHaveBeenCalled();
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('skips notify action when staff record does not exist', async () => {
    setupBreach(makeBreachedTicket(), [{ type: 'notify', staffId: 99 }]);
    (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await service.runPeriodicCheck();

    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('does not execute escalation rules when slaPlanId is null', async () => {
    // ticket with no SLA plan
    const ticket = makeBreachedTicket({ slaPlanId: null });
    (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
    (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await service.runPeriodicCheck();

    // escalationRule.findMany should NOT be called (no plan)
    expect(prisma.escalationRule.findMany).not.toHaveBeenCalled();
  });
});
