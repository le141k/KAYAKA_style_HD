import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthStaff } from '../../auth/auth.decorators';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import {
  enqueueWorkflowEmailEvent,
  WorkflowEmailEventService,
  type WorkflowEmailActionSnapshot,
} from './workflow-email-event.service';

const OPERATOR: AuthStaff = {
  staffId: 42,
  email: 'operator@example.test',
  isAdmin: false,
  permissions: ['mail.view', 'mail.replay'],
};

const WORKFLOW_UPDATED_AT = new Date('2026-07-22T10:00:00.000Z');
const ACTION: WorkflowEmailActionSnapshot = {
  workflowId: 7,
  workflowVersionMs: WORKFLOW_UPDATED_AT.getTime(),
  actionIndex: 0,
  to: 'customer@example.test',
  subject: '[TT-000001] Subject',
  text: 'Your case has been updated.',
};

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    mask: 'TT-000001',
    subject: 'Subject',
    requesterEmail: 'customer@example.test',
    requesterName: 'Customer',
    departmentId: 1,
    statusId: 1,
    priorityId: 1,
    typeId: null,
    userId: null,
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
  } as any;
}

function workflow() {
  return {
    id: 7,
    title: 'Customer update',
    criteria: [],
    actions: [{ type: 'send_email', value: ACTION.text }],
    isEnabled: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: WORKFLOW_UPDATED_AT,
  } as any;
}

describe('WorkflowEmailEvent durable trigger', () => {
  it('snapshots matched customer email actions under the business source key in the ticket transaction', async () => {
    const tx = {
      workflow: { findMany: vi.fn().mockResolvedValue([workflow()]) },
      workflowEmailEvent: {
        upsert: vi.fn().mockResolvedValue({
          ticketId: 1,
          eventType: 'ticket.replied',
          sourceKey: 'ticket-post:42',
          actions: [ACTION],
        }),
      },
    };

    await enqueueWorkflowEmailEvent(tx as never, ticket(), 'ticket.replied', 'ticket-post:42');

    expect(tx.workflowEmailEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceKey: 'ticket-post:42' },
        create: expect.objectContaining({
          ticketId: 1,
          eventType: 'ticket.replied',
          sourceKey: 'ticket-post:42',
          actions: [ACTION],
        }),
      }),
    );
  });

  it('projects scalar mutations through the ordered rule chain before selecting durable email actions (anti-false-green)', async () => {
    const statusTransition = {
      ...workflow(),
      id: 7,
      sortOrder: 0,
      criteria: [{ field: 'statusId', op: 'eq', value: 1 }],
      actions: [{ type: 'set_status', value: '2' }],
    };
    const staleStatusRule = {
      ...workflow(),
      id: 8,
      sortOrder: 1,
      criteria: [{ field: 'statusId', op: 'eq', value: 1 }],
      actions: [{ type: 'send_email', value: 'must not be selected from the stale ticket' }],
    };
    const projectedStatusRule = {
      ...workflow(),
      id: 9,
      sortOrder: 2,
      criteria: [{ field: 'statusId', op: 'eq', value: 2 }],
      actions: [{ type: 'send_email', value: 'selected after the status transition' }],
    };
    const upsert = vi.fn().mockImplementation(async ({ create }) => create);
    const tx = {
      workflow: {
        findMany: vi.fn().mockResolvedValue([statusTransition, staleStatusRule, projectedStatusRule]),
      },
      workflowEmailEvent: { upsert },
    };

    await enqueueWorkflowEmailEvent(tx as never, ticket({ statusId: 1 }), 'ticket.replied', 'ticket-post:43');

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceKey: 'ticket-post:43',
          actions: [
            expect.objectContaining({
              workflowId: 9,
              actionIndex: 0,
              text: 'selected after the status transition',
            }),
          ],
        }),
      }),
    );
  });

  it('quarantines a malformed legacy send_email action without rolling back the ticket transaction', async () => {
    const malformedRule = {
      ...workflow(),
      actions: [
        { type: 'send_email', value: 'would be valid alone' },
        { type: 'send_email', value: '   ' },
      ],
    };
    const upsert = vi.fn().mockImplementation(async ({ create }) => create);
    const tx = {
      workflow: { findMany: vi.fn().mockResolvedValue([malformedRule]) },
      workflowEmailEvent: { upsert },
    };

    await expect(
      enqueueWorkflowEmailEvent(tx as never, ticket(), 'ticket.replied', 'ticket-post:malformed-rule'),
    ).resolves.toBeUndefined();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceKey: expect.stringMatching(/^workflow-email-invalid:/),
          actions: [],
          state: 'QUARANTINED',
          lastError: expect.stringContaining('Workflow 7 action 1'),
        }),
      }),
    );
    expect(upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ sourceKey: 'ticket-post:malformed-rule' }),
      }),
    );
  });

  it('accepts a replay only after the durable source key resolves to the same ticket and event type', async () => {
    const tx = {
      workflow: { findMany: vi.fn().mockResolvedValue([workflow()]) },
      workflowEmailEvent: {
        // The existing immutable snapshot intentionally differs: a rule was
        // edited after the original ticket mutation.  The old event wins.
        upsert: vi.fn().mockResolvedValue({
          ticketId: 1,
          eventType: 'ticket.replied',
          sourceKey: 'ticket-post:42',
          actions: [{ ...ACTION, text: 'original snapshot' }],
        }),
      },
    };

    await expect(
      enqueueWorkflowEmailEvent(tx as never, ticket(), 'ticket.replied', 'ticket-post:42'),
    ).resolves.toBeUndefined();
  });

  it('fails closed when a source-key collision belongs to another business event (anti-false-green)', async () => {
    const tx = {
      workflow: { findMany: vi.fn().mockResolvedValue([workflow()]) },
      workflowEmailEvent: {
        upsert: vi.fn().mockResolvedValue({
          ticketId: 999,
          eventType: 'ticket.replied',
          sourceKey: 'ticket-post:42',
          actions: [ACTION],
        }),
      },
    };

    await expect(
      enqueueWorkflowEmailEvent(tx as never, ticket(), 'ticket.replied', 'ticket-post:42'),
    ).rejects.toThrow('source conflict');
  });

  it('never converts an unexpected P2002 into successful delivery', async () => {
    const p2002 = Object.assign(new Error('unique violation'), { code: 'P2002' });
    const tx = {
      workflow: { findMany: vi.fn().mockResolvedValue([workflow()]) },
      workflowEmailEvent: { upsert: vi.fn().mockRejectedValue(p2002) },
    };

    await expect(
      enqueueWorkflowEmailEvent(tx as never, ticket(), 'ticket.replied', 'ticket-post:42'),
    ).rejects.toBe(p2002);
  });

  it('allows only one concurrent worker to materialize a source event and derives the outbox key from it', async () => {
    const event: Record<string, any> = {
      id: 'event-1',
      ticketId: 1,
      eventType: 'ticket.replied',
      sourceKey: 'ticket-post:42',
      actions: [ACTION],
      state: 'PENDING',
      attempts: 0,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseVersion: 0,
      lastError: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const updateMany = vi.fn(
      async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        if (data.state === 'PROCESSING' && data.attempts) {
          if (event.state !== 'PENDING') return { count: 0 };
          event.state = 'PROCESSING';
          event.attempts += 1;
          event.leaseOwner = data.leaseOwner;
          event.leaseExpiresAt = data.leaseExpiresAt;
          event.leaseVersion += 1;
          return { count: 1 };
        }
        if (data.state === 'PROCESSED') {
          if (event.state !== 'PROCESSING' || event.leaseOwner !== where.leaseOwner) return { count: 0 };
          event.state = 'PROCESSED';
          event.leaseOwner = null;
          event.leaseExpiresAt = null;
          return { count: 1 };
        }
        if (data.leaseExpiresAt) {
          if (event.state !== 'PROCESSING' || event.leaseOwner !== where.leaseOwner) return { count: 0 };
          event.leaseExpiresAt = data.leaseExpiresAt;
          return { count: 1 };
        }
        return { count: 0 };
      },
    );
    const prisma = {
      workflowEmailEvent: {
        updateMany,
        findUnique: vi.fn().mockImplementation(async () => ({ ...event })),
        findMany: vi.fn().mockResolvedValue([]),
      },
      ticket: { findUnique: vi.fn().mockResolvedValue({ requesterEmail: ACTION.to }) },
    } as unknown as PrismaService;
    const mail = {
      createWorkflowTicketEmail: vi.fn().mockResolvedValue({ id: 'outbound-1' }),
      enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    } as unknown as MailService;
    const service = new WorkflowEmailEventService(prisma, mail, { ticketWhere: vi.fn() } as never);

    await Promise.all([service.processEvent(event.id), service.processEvent(event.id)]);
    await Promise.resolve();

    expect(mail.createWorkflowTicketEmail).toHaveBeenCalledTimes(1);
    expect(mail.createWorkflowTicketEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey:
          `workflow-email:${event.sourceKey}:workflow:${ACTION.workflowId}:` +
          `v:${ACTION.workflowVersionMs}:action:${ACTION.actionIndex}`,
      }),
    );
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('outbound-1');
    expect(event.state).toBe('PROCESSED');
  });
});

describe('WorkflowEmailEvent operator recovery', () => {
  function operatorEvent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'workflow-event-1',
      ticketId: 1,
      eventType: 'ticket.replied',
      sourceKey: 'ticket-post:42',
      actions: [ACTION],
      state: 'QUARANTINED',
      attempts: 10,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      leaseVersion: 3,
      lastError: 'requester email changed or is unavailable',
      processedAt: null,
      createdAt: new Date('2026-07-22T08:00:00.000Z'),
      updatedAt: new Date('2026-07-22T09:00:00.000Z'),
      ticket: {
        id: 1,
        mask: 'TT-000001',
        subject: 'Subject',
        requesterEmail: ACTION.to,
      },
      ...overrides,
    } as any;
  }

  function operatorAccess() {
    return {
      ticketWhere: vi.fn().mockResolvedValue({
        department: { is: { staff: { some: { staffId: OPERATOR.staffId } } } },
      }),
    };
  }

  it('scopes the metadata list to TicketAccess and strips recipient/body even from an overbroad query double', async () => {
    const event = operatorEvent();
    const prisma = {
      workflowEmailEvent: {
        findMany: vi.fn().mockResolvedValue([event]),
        count: vi.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaService;
    const access = operatorAccess();
    const service = new WorkflowEmailEventService(prisma, {} as MailService, access as never);

    const page = await service.listOperatorEvents({ page: 1, limit: 25 }, OPERATOR);

    expect(access.ticketWhere).toHaveBeenCalledWith(OPERATOR);
    expect(prisma.workflowEmailEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([expect.objectContaining({ ticket: { is: expect.any(Object) } })]),
        }),
      }),
    );
    expect(page.items[0]).toMatchObject({ id: event.id, ticket: { id: 1, mask: 'TT-000001' } });
    expect(page.items[0]).not.toHaveProperty('actions');
    expect(page.items[0]).not.toHaveProperty('ticket.requesterEmail');
  });

  it('returns the same not-found shape for an event outside the ticket scope and never exposes its action preview', async () => {
    const prisma = {
      workflowEmailEvent: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaService;
    const service = new WorkflowEmailEventService(prisma, {} as MailService, operatorAccess() as never);

    await expect(service.getOperatorEvent('other-department-event', OPERATOR)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.workflowEmailEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ AND: expect.any(Array) }),
      }),
    );
  });

  it('uses an updatedAt CAS and never writes an audit record after a stale replay loses the race', async () => {
    const event = operatorEvent();
    const tx = {
      workflowEmailEvent: {
        findFirst: vi.fn().mockResolvedValue(event),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      ticketAuditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const service = new WorkflowEmailEventService(prisma, {} as MailService, operatorAccess() as never);
    vi.spyOn(service, 'processEvent').mockResolvedValue(undefined);

    await expect(
      service.replayOperatorEvent(
        event.id,
        { reason: 'operator checked the transport fix', expectedUpdatedAt: event.updatedAt },
        OPERATOR,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.workflowEmailEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ AND: expect.any(Array) }),
      }),
    );
    expect(tx.ticketAuditLog.create).not.toHaveBeenCalled();
  });

  it('blocks a requester-changed quarantine before CAS/reset and keeps its immutable snapshot untouched', async () => {
    const event = operatorEvent({
      ticket: { id: 1, mask: 'TT-000001', subject: 'Subject', requesterEmail: 'new@example.test' },
    });
    const tx = {
      workflowEmailEvent: { findFirst: vi.fn().mockResolvedValue(event), updateMany: vi.fn() },
      ticketAuditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const service = new WorkflowEmailEventService(prisma, {} as MailService, operatorAccess() as never);

    await expect(
      service.replayOperatorEvent(
        event.id,
        { reason: 'try again', expectedUpdatedAt: event.updatedAt },
        OPERATOR,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Requester email changed'),
    } as BadRequestException);

    expect(tx.workflowEmailEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.ticketAuditLog.create).not.toHaveBeenCalled();
  });

  it('blocks malformed legacy snapshots instead of treating a manual replay as permission to send', async () => {
    const event = operatorEvent({ actions: [] });
    const tx = {
      workflowEmailEvent: { findFirst: vi.fn().mockResolvedValue(event), updateMany: vi.fn() },
      ticketAuditLog: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const service = new WorkflowEmailEventService(prisma, {} as MailService, operatorAccess() as never);

    await expect(
      service.replayOperatorEvent(
        event.id,
        { reason: 'try malformed snapshot', expectedUpdatedAt: event.updatedAt },
        OPERATOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.workflowEmailEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.ticketAuditLog.create).not.toHaveBeenCalled();
  });

  it('replays only the inspected quarantined version and writes actor + reason into TicketAuditLog', async () => {
    const event = operatorEvent({ lastError: 'SMTP timeout' });
    const tx = {
      workflowEmailEvent: {
        findFirst: vi.fn().mockResolvedValue(event),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      ticketAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaService;
    const service = new WorkflowEmailEventService(prisma, {} as MailService, operatorAccess() as never);
    vi.spyOn(service, 'processEvent').mockResolvedValue(undefined);
    const reason = 'SMTP credentials were repaired and verified';

    await expect(
      service.replayOperatorEvent(event.id, { reason, expectedUpdatedAt: event.updatedAt }, OPERATOR),
    ).resolves.toEqual({ replayed: true });

    expect(tx.workflowEmailEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: 'PENDING',
          attempts: 0,
          leaseVersion: { increment: 1 },
        }),
      }),
    );
    expect(tx.ticketAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ticketId: event.ticketId,
          staffId: OPERATOR.staffId,
          action: 'WORKFLOW_EMAIL_REPLAY',
          oldValue: 'SMTP timeout',
          newValue: expect.stringContaining(reason),
        }),
      }),
    );
  });

  it('projects stale leases, quarantine, retry and aged backlog into ticket-scoped health alerts', async () => {
    const now = new Date('2026-07-22T12:00:00.000Z');
    const prisma = {
      workflowEmailEvent: {
        groupBy: vi.fn().mockResolvedValue([
          { state: 'PENDING', _count: { _all: 2 } },
          { state: 'PROCESSING', _count: { _all: 1 } },
          { state: 'RETRY', _count: { _all: 3 } },
          { state: 'QUARANTINED', _count: { _all: 4 } },
          { state: 'PROCESSED', _count: { _all: 5 } },
        ]),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ createdAt: new Date('2026-07-22T11:40:00.000Z') })
          .mockResolvedValueOnce({ processedAt: new Date('2026-07-22T11:59:00.000Z') }),
        count: vi.fn().mockResolvedValue(1),
      },
    } as unknown as PrismaService;
    const service = new WorkflowEmailEventService(prisma, {} as MailService, operatorAccess() as never);

    const health = await service.operatorHealth(OPERATOR, now);

    expect(health).toMatchObject({
      backlog: 5,
      byState: { pending: 2, processing: 1, retry: 3, quarantined: 4, processed: 5 },
      stalledProcessing: 1,
    });
    expect(health.alerts.map((alert) => alert.kind)).toEqual(
      expect.arrayContaining([
        'workflow_email_quarantine',
        'workflow_email_stalled',
        'workflow_email_retry',
        'workflow_email_aged_backlog',
      ]),
    );
  });

  it('recovery claims due IDs through the same lease-fenced worker path', async () => {
    const prisma = {
      workflowEmailEvent: { findMany: vi.fn().mockResolvedValue([{ id: 'due-1' }, { id: 'due-2' }]) },
    } as unknown as PrismaService;
    const service = new WorkflowEmailEventService(
      prisma,
      {} as MailService,
      { ticketWhere: vi.fn() } as never,
    );
    const process = vi.spyOn(service, 'processEvent').mockResolvedValue(undefined);

    await service.recoverDueEvents();

    expect(process).toHaveBeenCalledWith('due-1');
    expect(process).toHaveBeenCalledWith('due-2');
  });
});
