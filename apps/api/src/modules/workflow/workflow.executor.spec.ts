import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkflowExecutor } from './workflow.executor';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Ticket, Workflow } from '@prisma/client';

function makePrismaMock() {
  const prisma = {
    ticket: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    workflow: {
      findMany: vi.fn(),
    },
    ticketNote: {
      create: vi.fn(),
    },
    staff: {
      findUnique: vi.fn(),
    },
    ticketAuditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  return prisma as unknown as PrismaService;
}

function makeNotificationsMock() {
  return {
    queueAssignmentNotification: vi.fn().mockResolvedValue(undefined),
    wakeCommittedNotifications: vi.fn(),
  };
}

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    kayakoId: null,
    mask: 'TT-000001',
    subject: 'Test subject',
    departmentId: 1,
    statusId: 1,
    priorityId: 2,
    typeId: null,
    userId: 1,
    requesterName: 'Test User',
    requesterEmail: 'test@example.com',
    ownerStaffId: null,
    slaPlanId: null,
    dueAt: null,
    resolutionDueAt: null,
    firstResponseAt: null,
    resolvedAt: null,
    reopenedAt: null,
    creationMode: 'WEB',
    creator: 'USER',
    flagType: 'NONE',
    totalReplies: 1,
    hasAttachments: false,
    hasNotes: false,
    isResolved: false,
    isEscalated: false,
    escalationLevel: 0,
    wasReopened: false,
    isPhoneCall: false,
    ipAddress: '0.0.0.0',
    messageId: '',
    mergedIntoId: null,
    customFields: {},
    lastReplyAt: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 1,
    title: 'Test Workflow',
    criteria: [],
    actions: [],
    isEnabled: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('WorkflowExecutor', () => {
  let executor: WorkflowExecutor;
  let prisma: ReturnType<typeof makePrismaMock>;
  let notifications: ReturnType<typeof makeNotificationsMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    notifications = makeNotificationsMock();
    executor = new WorkflowExecutor(prisma as unknown as PrismaService, notifications as never);
  });

  // ─── matchesCriteria (via evaluate -> exposed indirectly through onTicketCreated) ─

  describe('matchesCriteria (via evaluate)', () => {
    it('matches when criteria is empty (no restrictions)', async () => {
      const ticket = makeTicket();
      const workflow = makeWorkflow({
        criteria: [] as any,
        actions: [{ type: 'change_status', statusId: 3 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...ticket, statusId: 3 });

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ statusId: 3 }) }),
      );
    });

    it('matches eq criterion when field equals value', async () => {
      const ticket = makeTicket({ statusId: 1 });
      const workflow = makeWorkflow({
        criteria: [{ field: 'statusId', op: 'eq', value: 1 }] as any,
        actions: [{ type: 'change_priority', priorityId: 5 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ priorityId: 5 }) }),
      );
    });

    it('does NOT apply actions when eq criterion fails', async () => {
      const ticket = makeTicket({ statusId: 2 });
      const workflow = makeWorkflow({
        criteria: [{ field: 'statusId', op: 'eq', value: 1 }] as any,
        actions: [{ type: 'change_priority', priorityId: 5 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('matches neq criterion when field differs from value', async () => {
      const ticket = makeTicket({ statusId: 3 });
      const workflow = makeWorkflow({
        criteria: [{ field: 'statusId', op: 'neq', value: 1 }] as any,
        actions: [{ type: 'change_department', departmentId: 2 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ departmentId: 2 }) }),
      );
    });

    it('matches contains criterion on string field', async () => {
      const ticket = makeTicket({ subject: 'Urgent: server is down' });
      const workflow = makeWorkflow({
        criteria: [{ field: 'subject', op: 'contains', value: 'urgent' }] as any,
        actions: [{ type: 'change_priority', priorityId: 1 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalled();
    });

    it('matches gt criterion when field is greater than value', async () => {
      const ticket = makeTicket({ totalReplies: 10 });
      const workflow = makeWorkflow({
        criteria: [{ field: 'totalReplies', op: 'gt', value: 5 }] as any,
        actions: [{ type: 'change_priority', priorityId: 1 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalled();
    });

    it('matches lt criterion when field is less than value', async () => {
      const ticket = makeTicket({ totalReplies: 2 });
      const workflow = makeWorkflow({
        criteria: [{ field: 'totalReplies', op: 'lt', value: 5 }] as any,
        actions: [{ type: 'change_status', statusId: 2 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalled();
    });

    it('does NOT apply actions when ticket is not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await executor.onTicketCreated({ ticketId: 999 });

      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('applies later rules against the scalar state committed by earlier rules', async () => {
      const initial = makeTicket({ statusId: 1, priorityId: 2 });
      const afterStatus = makeTicket({ statusId: 2, priorityId: 2 });
      const afterPriority = makeTicket({ statusId: 2, priorityId: 9 });
      const statusRule = makeWorkflow({
        id: 1,
        sortOrder: 0,
        criteria: [{ field: 'statusId', op: 'eq', value: 1 }] as any,
        actions: [{ type: 'set_status', value: '2' }] as any,
      });
      const priorityRule = makeWorkflow({
        id: 2,
        sortOrder: 1,
        criteria: [{ field: 'statusId', op: 'eq', value: 2 }] as any,
        actions: [{ type: 'set_priority', value: '9' }] as any,
      });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(afterStatus)
        .mockResolvedValueOnce(afterPriority);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([statusRule, priorityRule]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(afterStatus)
        .mockResolvedValueOnce(afterPriority);

      await executor.onTicketCreated({ ticketId: initial.id });

      expect(prisma.ticket.update).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ data: expect.objectContaining({ statusId: 2 }) }),
      );
      expect(prisma.ticket.update).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ data: expect.objectContaining({ priorityId: 9 }) }),
      );
    });
  });

  // ─── applyActions ────────────────────────────────────────────────────────────

  describe('applyActions', () => {
    it('never sends customer email from the in-memory EventEmitter path', async () => {
      const ticket = makeTicket();
      const workflow = makeWorkflow({
        actions: [{ type: 'send_email', value: 'Your case has been updated.' }] as any,
      });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);

      await executor.onTicketCreated({ ticketId: ticket.id });

      // WorkflowEmailEvent is inserted with the ticket mutation, before this
      // listener runs.  Calling the listener twice must not create mail or audit
      // rows itself; its only job for send_email is to leave the durable worker
      // alone.
      await executor.onTicketCreated({ ticketId: ticket.id });
      expect(prisma.ticketAuditLog.create).not.toHaveBeenCalled();
    });

    it('applies change_owner action (setting ownerStaffId)', async () => {
      const ticket = makeTicket();
      const workflow = makeWorkflow({
        actions: [{ type: 'change_owner', ownerStaffId: 7 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      // Owner is now existence-validated before assigning (H8-1).
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerStaffId: 7 }) }),
      );
    });

    it('applies change_type action', async () => {
      const ticket = makeTicket();
      const workflow = makeWorkflow({
        actions: [{ type: 'change_type', typeId: 3 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ typeId: 3 }) }),
      );
    });

    it('applies add_note action by creating a ticket note', async () => {
      const ticket = makeTicket();
      const workflow = makeWorkflow({
        criteria: [] as any,
        actions: [{ type: 'add_note', note: 'Auto note' }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticketNote.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticketNote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            ticketId: 1,
            contents: expect.stringContaining('Auto note'),
          }),
        }),
      );
    });

    it('applies add_tag action via ticket.update with connectOrCreate', async () => {
      const ticket = makeTicket();
      const workflow = makeWorkflow({
        criteria: [] as any,
        actions: [{ type: 'add_tag', tag: 'vip' }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tags: expect.objectContaining({
              connectOrCreate: expect.objectContaining({ where: { name: 'vip' } }),
            }),
          }),
        }),
      );
    });

    it('does not call ticket.update when actions produce no field changes', async () => {
      const ticket = makeTicket();
      // An add_note action alone does not produce field update
      const workflow = makeWorkflow({
        actions: [{ type: 'add_note', note: 'A note' }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticketNote.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await executor.onTicketCreated({ ticketId: 1 });

      // ticket.update should NOT be called since ticketUpdate is empty
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('handles status_changed event through onTicketStatusChanged', async () => {
      const ticket = makeTicket();
      const workflow = makeWorkflow({
        actions: [{ type: 'change_priority', priorityId: 1 }] as any,
      });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await executor.onTicketStatusChanged({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalled();
    });

    it('handles replied event through onTicketReplied', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await executor.onTicketReplied({ ticketId: 1 });

      // Just ensuring it runs without error
      expect(prisma.workflow.findMany).toHaveBeenCalled();
    });
  });

  // ─── H8-1: assign action (vocab unify + validate + notify + audit) ───
  describe('assign action', () => {
    it('the macro-vocab "assign" sets owner, audits ASSIGN, and notifies', async () => {
      const ticket = makeTicket({ ownerStaffId: null });
      const workflow = makeWorkflow({
        criteria: [] as any,
        actions: [{ type: 'assign', value: '7' }] as any,
      });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      // Prisma returns the post-update row. The assignment command must receive
      // that snapshot, not the ticket loaded before the owner mutation.
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...ticket, ownerStaffId: 7 });
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 71 });
      notifications.queueAssignmentNotification.mockResolvedValue('assignment-outbox-7');

      await executor.onTicketCreated({ ticketId: 1 });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerStaffId: 7 }) }),
      );
      expect(prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'ASSIGN', newValue: '7' }),
          select: { id: true },
        }),
      );
      expect(notifications.queueAssignmentNotification).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({ id: 1, ownerStaffId: 7 }),
        7,
        'audit:71',
      );
      expect(notifications.wakeCommittedNotifications).toHaveBeenCalledWith(['assignment-outbox-7']);
    });

    it('keeps owner update, audit and assignment outbox inside one transaction and wakes only after commit', async () => {
      const initial = makeTicket({ ownerStaffId: null, departmentId: 1 });
      const updated = makeTicket({ ownerStaffId: 7, departmentId: 1 });
      const tx = {
        ticket: { update: vi.fn().mockResolvedValue(updated) },
        ticketAuditLog: { create: vi.fn().mockResolvedValue({ id: 88 }) },
      };
      let commit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        commit = resolve;
      });
      let transactionWorkFinished!: () => void;
      const transactionWorkFinishedGate = new Promise<void>((resolve) => {
        transactionWorkFinished = resolve;
      });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(updated);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeWorkflow({ actions: [{ type: 'assign', value: '7' }] as any }),
      ]);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
        async (callback: (client: typeof tx) => unknown) => {
          const result = await callback(tx);
          transactionWorkFinished();
          await commitGate;
          return result;
        },
      );
      notifications.queueAssignmentNotification.mockResolvedValue('assignment-command-88');

      const evaluation = executor.onTicketCreated({ ticketId: initial.id });
      // Wait for the transaction callback itself rather than assuming how many
      // async boundaries workflow matching reaches before the assign action.
      await transactionWorkFinishedGate;

      expect(tx.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerStaffId: 7 }) }),
      );
      expect(tx.ticketAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'ASSIGN' }) }),
      );
      expect(notifications.queueAssignmentNotification).toHaveBeenCalledWith(tx, updated, 7, 'audit:88');
      expect(notifications.wakeCommittedNotifications).not.toHaveBeenCalled();

      commit();
      await evaluation;

      expect(notifications.wakeCommittedNotifications).toHaveBeenCalledWith(['assignment-command-88']);
      expect(prisma.ticket.update as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });

    it('does not swallow a durable assignment-notification failure or wake an uncommitted command', async () => {
      const initial = makeTicket({ ownerStaffId: null });
      const updated = makeTicket({ ownerStaffId: 7 });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(initial);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeWorkflow({ actions: [{ type: 'assign', value: '7' }] as any }),
      ]);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(updated);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 89 });
      notifications.queueAssignmentNotification.mockRejectedValue(new Error('outbox template unavailable'));

      await expect(executor.onTicketCreated({ ticketId: initial.id })).rejects.toThrow(
        'outbox template unavailable',
      );

      expect(notifications.wakeCommittedNotifications).not.toHaveBeenCalled();
    });

    it('skips assign to a nonexistent staff (no owner update, no notify)', async () => {
      const ticket = makeTicket({ ownerStaffId: null });
      const workflow = makeWorkflow({
        criteria: [] as any,
        actions: [{ type: 'assign', value: '999' }] as any,
      });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([workflow]);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await executor.onTicketCreated({ ticketId: 1 });

      // ownerStaffId never set → no ticket.update, no notification.
      expect(prisma.ticket.update as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(notifications.queueAssignmentNotification).not.toHaveBeenCalled();
    });
  });

  // ─── C3: enabled-workflows cache ───────────────────────────────────────────
  describe('workflow cache (C3)', () => {
    it('queries workflows once across multiple ticket events, then re-queries after invalidation', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await executor.onTicketCreated({ ticketId: 1 });
      await executor.onTicketReplied({ ticketId: 1 });
      await executor.onTicketStatusChanged({ ticketId: 1 });
      // Three events, one workflow query (the ticket itself is still fetched each time).
      expect(prisma.workflow.findMany).toHaveBeenCalledTimes(1);

      // A workflow write busts the cache → next event re-queries.
      executor.invalidateWorkflowCache();
      await executor.onTicketCreated({ ticketId: 1 });
      expect(prisma.workflow.findMany).toHaveBeenCalledTimes(2);
    });
  });

  // ─── A5(iii): re-entrancy depth guard ──────────────────────────────────────
  describe('recursion guard (A5)', () => {
    it('stops re-entrant evaluation of the same ticket past the depth cap', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      // A self-re-entrant workflow: its action re-enters evaluation for the same
      // ticket. Without the guard this recurses forever; with it, it terminates.
      let evaluations = 0;
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        evaluations++;
        // Re-enter synchronously (simulating an action that re-fires the event).
        await executor.onTicketStatusChanged({ ticketId: ticket.id });
        return [];
      });

      await executor.onTicketStatusChanged({ ticketId: ticket.id });

      // Bounded by MAX_WORKFLOW_DEPTH (5) — not unbounded.
      expect(evaluations).toBeLessThanOrEqual(5);
      expect(evaluations).toBeGreaterThan(0);
    });

    it('re-fetches the ticket after a mutating workflow (no stale snapshot)', async () => {
      const ticket = makeTicket({ statusId: 1 });
      const fresh = makeTicket({ statusId: 3 });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ticket)
        .mockResolvedValueOnce(fresh);
      // One workflow that changes status (mutates) → triggers a re-fetch.
      const wf = makeWorkflow({
        criteria: [] as any,
        actions: [{ type: 'change_status', statusId: 3 }] as any,
      });
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([wf]);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(fresh);

      await executor.onTicketStatusChanged({ ticketId: 1 });

      // findUnique called twice: initial snapshot + re-fetch after the mutation.
      expect(prisma.ticket.findUnique).toHaveBeenCalledTimes(2);
    });
  });
});
