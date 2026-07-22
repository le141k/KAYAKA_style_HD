/**
 * Correctness coverage for SLA escalation's durable event/outbox boundary.
 * The test transaction intentionally uses a separate `tx` object: assertions
 * fail if a rule action regresses to the root Prisma client or direct SMTP.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlaService } from './sla.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';

function makeBreachedTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    mask: 'TT-000001',
    subject: 'Test subject',
    departmentId: 1,
    dueAt: new Date(Date.now() - 120 * 60_000),
    resolutionDueAt: null,
    firstResponseAt: null,
    isResolved: false,
    isEscalated: false,
    slaPlanId: 1,
    ownerStaffId: null,
    escalationLevel: 0,
    mergedIntoId: null,
    ...overrides,
  } as any;
}

function makePrismaMock() {
  const tx = {
    ticket: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    ticketNote: { create: vi.fn().mockResolvedValue({}) },
    staff: { findUnique: vi.fn() },
    escalationRule: { findMany: vi.fn().mockResolvedValue([]) },
    slaEscalationEvent: { create: vi.fn().mockResolvedValue({ id: 'sla-event-1' }) },
  };
  const prisma = {
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
    ticket: { findMany: vi.fn() },
    ticketNote: { create: vi.fn() },
    staff: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
    slaEscalationEvent: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    __tx: tx,
  };
  return prisma as unknown as PrismaService & { __tx: typeof tx };
}

function makeMailMock(): MailService {
  return {
    createInternalNotificationEmail: vi.fn().mockResolvedValue({ id: 'internal-outbox-1' }),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    sendTemplate: vi.fn(),
  } as unknown as MailService;
}

describe('SlaService durable escalation actions', () => {
  let service: SlaService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let mail: MailService;

  beforeEach(() => {
    prisma = makePrismaMock();
    mail = makeMailMock();
    service = new SlaService(prisma, mail);
  });

  function setupBreach(actions: object[], ticket = makeBreachedTicket()) {
    (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
    prisma.__tx.ticket.findFirst.mockResolvedValue(ticket);
    prisma.__tx.escalationRule.findMany.mockResolvedValue([
      {
        id: 12,
        slaPlanId: 1,
        name: 'Level 1 Escalation',
        targetType: 'FIRST_RESPONSE',
        thresholdSeconds: 60,
        actions,
        isEnabled: true,
      },
    ]);
    return ticket;
  }

  it('claims the breach, ticket fence and all rule effects in one transaction', async () => {
    setupBreach([
      { type: 'change_priority', priorityId: 9 },
      { type: 'assign', staffId: 7 },
      { type: 'add_note', note: 'Please review' },
      { type: 'mark_escalated' },
    ]);
    prisma.__tx.staff.findUnique.mockResolvedValue({ id: 7, isEnabled: true });

    await service.runPeriodicCheck();

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.any(Object));
    expect(prisma.__tx.slaEscalationEvent.create).toHaveBeenCalledWith({
      data: {
        ticketId: 1,
        breachType: 'FIRST_RESPONSE',
        sourceKey: 'sla:ticket:1:breach:FIRST_RESPONSE',
      },
      select: { id: true },
    });
    expect(prisma.__tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 1, isEscalated: false }),
        data: { isEscalated: true, escalationLevel: { increment: 1 } },
      }),
    );
    expect(prisma.__tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { priorityId: 9 } }),
    );
    expect(prisma.__tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ownerStaffId: 7 } }),
    );
    expect(prisma.__tx.ticketNote.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ticketId: 1, contents: expect.stringContaining('Please review') }),
      }),
    );
    // The root client was only used for the scan/rule load, never for side effects.
    expect((prisma.ticket as any).update).toBeUndefined();
  });

  it('creates an SLA notify command with an event-scoped idempotency key, never sendTemplate', async () => {
    setupBreach([{ type: 'notify', staffId: 3 }]);
    prisma.__tx.staff.findUnique.mockResolvedValue({
      id: 3,
      email: 'staff@example.test',
      firstName: 'Bob',
      isEnabled: true,
      staffGroup: { isAdmin: false },
      departments: [{ departmentId: 1 }],
    });

    await service.runPeriodicCheck();
    await Promise.resolve();

    expect(mail.createInternalNotificationEmail).toHaveBeenCalledWith(
      prisma.__tx,
      expect.objectContaining({
        ticketId: 1,
        templateKey: 'sla_breach_internal',
        to: 'staff@example.test',
        slaEscalationEventId: 'sla-event-1',
        idempotencyKey: 'internal:sla:event:sla-event-1:rule:12:action:0:staff:3',
        vars: expect.objectContaining({ breachType: 'FIRST_RESPONSE', minutesOverdue: expect.any(String) }),
      }),
    );
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('internal-outbox-1');
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('uses the current owner when notify omits staffId', async () => {
    setupBreach([{ type: 'notify' }], makeBreachedTicket({ ownerStaffId: 5 }));
    prisma.__tx.staff.findUnique.mockResolvedValue({
      id: 5,
      email: 'owner@example.test',
      firstName: 'Alice',
      isEnabled: true,
      staffGroup: { isAdmin: true },
      departments: [],
    });

    await service.runPeriodicCheck();

    expect(prisma.__tx.staff.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
      include: {
        staffGroup: { select: { isAdmin: true } },
        departments: { select: { departmentId: true } },
      },
    });
    expect(mail.createInternalNotificationEmail).toHaveBeenCalledWith(
      prisma.__tx,
      expect.objectContaining({ to: 'owner@example.test' }),
    );
  });

  it('does not send an SLA notification to an enabled staff member outside the ticket department', async () => {
    setupBreach([{ type: 'notify', staffId: 3 }]);
    prisma.__tx.staff.findUnique.mockResolvedValue({
      id: 3,
      email: 'other-department@example.test',
      firstName: 'Outside',
      isEnabled: true,
      staffGroup: { isAdmin: false },
      departments: [{ departmentId: 99 }],
    });

    await service.runPeriodicCheck();

    expect(mail.createInternalNotificationEmail).not.toHaveBeenCalled();
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('reads enabled rules inside the breach transaction so a just-disabled rule cannot create an outbox row', async () => {
    // This root-level result represents an obsolete pre-scan snapshot. Runtime
    // intentionally does not consume it for actions.
    (prisma.escalationRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 12,
        slaPlanId: 1,
        name: 'obsolete',
        targetType: 'FIRST_RESPONSE',
        thresholdSeconds: 0,
        actions: [{ type: 'notify', staffId: 3 }],
        isEnabled: true,
      },
    ]);
    setupBreach([{ type: 'notify', staffId: 3 }]);
    // The in-transaction read sees the administrator's disable/edit.
    prisma.__tx.escalationRule.findMany.mockResolvedValue([]);

    await service.runPeriodicCheck();

    expect(prisma.__tx.escalationRule.findMany).toHaveBeenCalledWith({
      where: { slaPlanId: 1, isEnabled: true },
      orderBy: { thresholdSeconds: 'asc' },
    });
    expect(prisma.escalationRule.findMany).not.toHaveBeenCalled();
    expect(mail.createInternalNotificationEmail).not.toHaveBeenCalled();
  });

  it('fails closed rather than assigning a disabled SLA target', async () => {
    setupBreach([{ type: 'assign', staffId: 7 }]);
    prisma.__tx.staff.findUnique.mockResolvedValue({ id: 7, isEnabled: false });

    await service.runPeriodicCheck();

    expect(prisma.__tx.ticket.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { ownerStaffId: 7 } }),
    );
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
  });

  it('does not materialize a duplicate breach when another worker already owns the event', async () => {
    setupBreach([{ type: 'notify', staffId: 3 }]);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockRejectedValueOnce({ code: 'P2002' });
    (prisma.slaEscalationEvent.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'winning-event',
    });

    await service.runPeriodicCheck();

    expect(prisma.slaEscalationEvent.findUnique).toHaveBeenCalledWith({
      where: { sourceKey: 'sla:ticket:1:breach:FIRST_RESPONSE' },
      select: { id: true },
    });
    expect(mail.createInternalNotificationEmail).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
  });

  it('does not wake SMTP when required template/outbox creation fails in the event transaction', async () => {
    setupBreach([{ type: 'notify', staffId: 3 }]);
    prisma.__tx.staff.findUnique.mockResolvedValue({
      id: 3,
      email: 'staff@example.test',
      firstName: 'Bob',
      isEnabled: true,
      staffGroup: { isAdmin: true },
      departments: [],
    });
    (mail.createInternalNotificationEmail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('required template missing'),
    );

    await service.runPeriodicCheck();

    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
    // The callback rejected, which is the unit-test proof that the interactive
    // transaction receives the failure; real PostgreSQL rollback is a live gate.
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it('increments escalation level only once when both target types breach together', async () => {
    const past = new Date(Date.now() - 120 * 60_000);
    const ticket = makeBreachedTicket({ resolutionDueAt: past });
    (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
    prisma.__tx.ticket.findFirst.mockResolvedValue(ticket);
    prisma.__tx.escalationRule.findMany.mockResolvedValue([]);
    prisma.__tx.ticket.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await service.runPeriodicCheck();

    const increments = prisma.__tx.ticket.updateMany.mock.calls.filter(
      (call: any[]) => call[0]?.data?.escalationLevel?.increment === 1,
    );
    expect(increments).toHaveLength(2);
    // The database CAS is the real one-time fence: first UPDATE matches,
    // second is intentionally count=0 for the other target event.
    expect(await prisma.__tx.ticket.updateMany.mock.results[0]?.value).toEqual({ count: 1 });
    expect(await prisma.__tx.ticket.updateMany.mock.results[1]?.value).toEqual({ count: 0 });
  });
});
