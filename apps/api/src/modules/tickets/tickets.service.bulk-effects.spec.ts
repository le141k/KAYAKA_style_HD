import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '@prisma/client';
import { TicketsService } from './tickets.service';
import { enqueueWorkflowEmailEvent } from '../workflow/workflow-email-event.service';

// The transaction boundary belongs to TicketsService; mock the workflow planner
// here so these tests can prove exactly where the durable event is requested
// without duplicating the planner's own matching tests.
vi.mock('../workflow/workflow-email-event.service', () => ({
  enqueueWorkflowEmailEvent: vi.fn(),
}));

type MockFn = ReturnType<typeof vi.fn>;

interface BulkTransactionMock {
  ticket: { update: MockFn };
  ticketAuditLog: { create: MockFn };
}

interface BulkPrismaMock {
  ticket: { findMany: MockFn };
  ticketStatus: { findUnique: MockFn };
  staff: { findUnique: MockFn };
  $transaction: MockFn;
}

function updatedTicket(id: number, overrides: Record<string, unknown> = {}): Ticket {
  return {
    id,
    mask: `TT-${String(id).padStart(6, '0')}`,
    subject: `Ticket ${id}`,
    requesterEmail: 'requester@example.test',
    requesterName: 'Requester',
    departmentId: 2,
    statusId: 4,
    isResolved: false,
    ownerStaffId: null,
    ...overrides,
  } as Ticket;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('TicketsService bulk durable effects', () => {
  let tx: BulkTransactionMock;
  let prisma: BulkPrismaMock;
  let notifications: {
    queueAssignmentNotification: ReturnType<typeof vi.fn>;
    wakeCommittedNotifications: ReturnType<typeof vi.fn>;
    queueWatcherNotificationsForUserReply: ReturnType<typeof vi.fn>;
  };
  let emitter: { emit: ReturnType<typeof vi.fn> };
  let service: TicketsService;

  beforeEach(() => {
    vi.mocked(enqueueWorkflowEmailEvent).mockReset().mockResolvedValue(undefined);

    tx = {
      ticket: { update: vi.fn() },
      ticketAuditLog: { create: vi.fn() },
    };
    prisma = {
      ticket: { findMany: vi.fn() },
      ticketStatus: { findUnique: vi.fn() },
      staff: { findUnique: vi.fn().mockResolvedValue({ id: 5, isEnabled: true }) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    notifications = {
      queueAssignmentNotification: vi.fn().mockResolvedValue(undefined),
      wakeCommittedNotifications: vi.fn(),
      queueWatcherNotificationsForUserReply: vi.fn().mockResolvedValue([]),
    };
    emitter = { emit: vi.fn() };
    const sla = {
      computeDueDates: vi.fn(),
      resolvePlanForTicket: vi.fn(),
    };

    service = new TicketsService(
      prisma as never,
      {} as never,
      sla as never,
      emitter as never,
      {} as never,
      {} as never,
      notifications as never,
    );
  });

  it('queues every bulk assignment from its audit source inside the transaction and wakes only after commit', async () => {
    const changed = updatedTicket(11, { ownerStaffId: 5 });
    prisma.ticket.findMany.mockResolvedValue([
      { id: 11, departmentId: 2, isResolved: false, slaPlanId: null },
    ]);
    tx.ticket.update.mockResolvedValue(changed);
    tx.ticketAuditLog.create.mockResolvedValue({ id: 701 });
    notifications.queueAssignmentNotification.mockResolvedValue('assignment-outbox-701');

    const callbackFinished = deferred();
    const commitGate = deferred();
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
      const result = await callback(tx);
      callbackFinished.resolve();
      await commitGate.promise;
      return result;
    });

    const pending = service.bulkAction({ ids: [11], action: 'assignee', ownerStaffId: 5 }, 42);
    await callbackFinished.promise;

    expect(notifications.queueAssignmentNotification).toHaveBeenCalledWith(tx, changed, 5, 'audit:701');
    // Anti-false-green barrier: this fails if the command is only planned after
    // commit or if the wake-up is moved into the transaction.
    expect(notifications.wakeCommittedNotifications).not.toHaveBeenCalled();

    commitGate.resolve();
    await expect(pending).resolves.toEqual({ updated: 1, failed: [] });
    expect(notifications.wakeCommittedNotifications).toHaveBeenCalledWith(['assignment-outbox-701']);
  });

  it('creates a durable status workflow event from each bulk audit and emits only after commit', async () => {
    const changed = updatedTicket(22, { statusId: 8, isResolved: true });
    prisma.ticket.findMany.mockResolvedValue([
      { id: 22, departmentId: 2, isResolved: false, slaPlanId: null },
    ]);
    prisma.ticketStatus.findUnique.mockResolvedValue({
      markAsResolved: true,
    });
    tx.ticket.update.mockResolvedValue(changed);
    tx.ticketAuditLog.create.mockResolvedValue({ id: 702 });

    const callbackFinished = deferred();
    const commitGate = deferred();
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
      const result = await callback(tx);
      callbackFinished.resolve();
      await commitGate.promise;
      return result;
    });

    const pending = service.bulkAction({ ids: [22], action: 'status', statusId: 8 }, 42);
    await callbackFinished.promise;

    expect(enqueueWorkflowEmailEvent).toHaveBeenCalledWith(
      tx,
      changed,
      'ticket.status_changed',
      'ticket-audit:702',
    );
    // Anti-false-green barrier: a listener cannot observe an uncommitted status.
    expect(emitter.emit).not.toHaveBeenCalled();

    commitGate.resolve();
    await expect(pending).resolves.toEqual({ updated: 1, failed: [] });
    expect(emitter.emit).toHaveBeenCalledWith('ticket.status_changed', { ticketId: 22 });
  });

  it('does not leak a durable assignment wake-up when a later bulk member fails', async () => {
    const first = updatedTicket(31, { ownerStaffId: 5 });
    prisma.ticket.findMany.mockResolvedValue([
      { id: 31, departmentId: 2, isResolved: false, slaPlanId: null },
      { id: 32, departmentId: 2, isResolved: false, slaPlanId: null },
    ]);
    tx.ticket.update
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('second ticket write failed'));
    tx.ticketAuditLog.create.mockResolvedValue({ id: 703 });

    // Model the database transaction explicitly: the notification planner can
    // stage a command for member 31, but an error for member 32 discards it.
    let stagedCommandIds: string[] = [];
    let committedCommandIds: string[] = [];
    notifications.queueAssignmentNotification.mockImplementation(async () => {
      stagedCommandIds.push('assignment-outbox-703');
      return 'assignment-outbox-703';
    });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
      stagedCommandIds = [];
      try {
        const result = await callback(tx);
        committedCommandIds = [...stagedCommandIds];
        return result;
      } catch (error) {
        stagedCommandIds = [];
        throw error;
      }
    });

    await expect(
      service.bulkAction({ ids: [31, 32], action: 'assignee', ownerStaffId: 5 }, 42),
    ).rejects.toThrow('second ticket write failed');

    expect(committedCommandIds).toEqual([]);
    expect(notifications.wakeCommittedNotifications).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
