import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type Ticket, type WorkflowEmailEvent } from '@prisma/client';
import type { AuthStaff } from '../../auth/auth.decorators';
import { normalizeEmail } from '../../common/email.util';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { TicketAccessPolicy } from '../tickets/ticket-access-policy.service';
import type { ListWorkflowEmailEventsDto, ReplayWorkflowEmailEventDto } from './dto';
import { isWorkflowAction, projectWorkflowRuleChain, type WorkflowAction } from './workflow-matching';

/** Events currently emitted by TicketsService which may trigger customer mail. */
export type WorkflowEmailEventType = 'ticket.created' | 'ticket.replied' | 'ticket.status_changed';

/**
 * Immutable, bounded action data.  This is deliberately a snapshot rather than
 * a workflow relation: editing/deleting a rule after the ticket transaction
 * commits must not change or erase a customer notification already accepted.
 */
export interface WorkflowEmailActionSnapshot {
  workflowId: number;
  workflowVersionMs: number;
  actionIndex: number;
  to: string;
  subject: string;
  text: string;
}

const MAX_WORKFLOW_EMAIL_ACTIONS = 50;
const MAX_WORKFLOW_EMAIL_TEXT_CHARS = 50_000;
const WORKFLOW_EVENT_LEASE_MS = 60_000;
const WORKFLOW_EVENT_RECOVERY_MS = 30_000;
const WORKFLOW_EVENT_RECOVERY_BATCH = 100;
const WORKFLOW_EVENT_MAX_ATTEMPTS = 10;
const WORKFLOW_EVENT_HEALTH_ALERT_MS = 5 * 60_000;
const WORKFLOW_EVENT_STALE_MS = 15 * 60_000;

interface InvalidWorkflowEmailAction {
  workflowId: number;
  actionIndex: number;
  reason: string;
}

interface WorkflowEmailActionSnapshotResult {
  actions: WorkflowEmailActionSnapshot[];
  invalidActions: InvalidWorkflowEmailAction[];
}

export interface WorkflowEmailEventAlert {
  severity: 'warning' | 'critical';
  kind: string;
  message: string;
}

export interface WorkflowEmailEventHealth {
  backlog: number;
  byState: {
    pending: number;
    processing: number;
    retry: number;
    quarantined: number;
    processed: number;
  };
  stalledProcessing: number;
  oldestPendingAt: Date | null;
  lastProcessedAt: Date | null;
  alerts: WorkflowEmailEventAlert[];
  checkedAt: Date;
}

class WorkflowEmailEventLeaseLost extends Error {
  constructor() {
    super('Workflow email event lease lost');
  }
}

/**
 * Snapshot matching `send_email` actions in the transaction that changes the
 * ticket.  An EventEmitter may later wake a worker, but it never decides whether
 * customer mail exists: this row is the durable source of truth.
 */
export async function enqueueWorkflowEmailEvent(
  tx: Prisma.TransactionClient,
  ticket: Ticket,
  eventType: WorkflowEmailEventType,
  sourceKey: string,
): Promise<void> {
  if (!sourceKey || sourceKey.length > 255) {
    throw new Error('Workflow email event source key is invalid');
  }

  const { actions, invalidActions } = await snapshotWorkflowEmailActions(tx, ticket);

  // Legacy databases can contain workflow JSON written before send_email was
  // validated at the API boundary.  Do not let one bad administrator rule roll
  // back a customer's ticket/reply/status transaction; persist a terminal,
  // non-deliverable record instead.  It gives an operator durable evidence and
  // guarantees malformed content is never transformed into customer mail.
  for (const invalidAction of invalidActions) {
    await persistInvalidWorkflowEmailAction(tx, ticket, eventType, sourceKey, invalidAction);
  }
  if (actions.length === 0) return;

  const data = {
    ticketId: ticket.id,
    eventType,
    sourceKey,
    actions: actions as unknown as Prisma.InputJsonValue,
  };

  // `sourceKey` is the business-event fence (post/audit/split), not a process
  // UUID.  A matching existing row is a safe replay; a mismatching row is data
  // corruption and must fail the ticket transaction rather than silently attach
  // one customer's event to another mutation.
  const row = await tx.workflowEmailEvent.upsert({
    where: { sourceKey },
    create: data,
    update: {},
    select: { ticketId: true, eventType: true, sourceKey: true, actions: true },
  });
  if (row.ticketId !== ticket.id || row.eventType !== eventType || row.sourceKey !== sourceKey) {
    throw new Error(`Workflow email event source conflict for ${sourceKey}`);
  }
}

async function snapshotWorkflowEmailActions(
  tx: Prisma.TransactionClient,
  ticket: Ticket,
): Promise<WorkflowEmailActionSnapshotResult> {
  const recipient = normalizeEmail(ticket.requesterEmail ?? '');
  // A workflow notification always targets the requester.  With no requester
  // there is no safe recipient to persist, so no durable event is created.
  if (!recipient) return { actions: [], invalidActions: [] };

  const workflows = await tx.workflow.findMany({
    where: { isEnabled: true },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const snapshots: WorkflowEmailActionSnapshot[] = [];
  const invalidActions: InvalidWorkflowEmailAction[] = [];
  const ownerAvailability = new Map<number, boolean>();
  const canAssignOwner = async (staffId: number): Promise<boolean> => {
    const cached = ownerAvailability.get(staffId);
    if (cached !== undefined) return cached;
    const assignable = Boolean(await tx.staff.findUnique({ where: { id: staffId }, select: { id: true } }));
    ownerAvailability.set(staffId, assignable);
    return assignable;
  };

  // This shared projection mirrors WorkflowExecutor: after a matched rule's
  // scalar mutation, the next rule sees the projected status/department/owner
  // rather than the original ticket snapshot.  Email intents therefore follow
  // the same deterministic ordered rule chain as the non-email workflow work.
  const steps = await projectWorkflowRuleChain(ticket, workflows, { canAssignOwner });
  for (const step of steps) {
    const workflowActions: Array<{ actionIndex: number; text: string }> = [];
    let workflowIsInvalid = false;

    const rawActions = Array.isArray(step.workflow.actions) ? step.workflow.actions : [];
    for (const [actionIndex, rawAction] of rawActions.entries()) {
      if (!isWorkflowAction(rawAction) || rawAction.type !== 'send_email') continue;
      const text = workflowEmailText(rawAction);
      if (text === null) {
        invalidActions.push({
          workflowId: step.workflow.id,
          actionIndex,
          reason: 'send_email body is missing, invalid, or exceeds the configured limit',
        });
        workflowIsInvalid = true;
        continue;
      }
      workflowActions.push({ actionIndex, text });
    }

    // A malformed legacy rule is fail-closed for that rule only.  Do not send a
    // partial selection of its actions: the quarantine row above is the durable
    // operator signal, while unrelated valid rules can still notify correctly.
    if (workflowIsInvalid) continue;
    if (snapshots.length + workflowActions.length > MAX_WORKFLOW_EMAIL_ACTIONS) {
      for (const action of workflowActions) {
        invalidActions.push({
          workflowId: step.workflow.id,
          actionIndex: action.actionIndex,
          reason: `send_email action limit (${MAX_WORKFLOW_EMAIL_ACTIONS}) would be exceeded`,
        });
      }
      continue;
    }

    for (const action of workflowActions) {
      snapshots.push({
        workflowId: step.workflow.id,
        workflowVersionMs: step.workflow.updatedAt.getTime(),
        actionIndex: action.actionIndex,
        to: recipient,
        subject: `[${ticket.mask}] ${ticket.subject}`,
        text: action.text,
      });
    }
  }

  return { actions: snapshots, invalidActions };
}

function workflowEmailText(action: Pick<WorkflowAction, 'note' | 'value'>): string | null {
  const note = typeof action.note === 'string' ? action.note.trim() : '';
  const value = typeof action.value === 'string' ? action.value.trim() : '';
  const text = note || value;
  if (!text || text.length > MAX_WORKFLOW_EMAIL_TEXT_CHARS) return null;
  return text;
}

async function persistInvalidWorkflowEmailAction(
  tx: Prisma.TransactionClient,
  ticket: Ticket,
  eventType: WorkflowEmailEventType,
  sourceKey: string,
  invalidAction: InvalidWorkflowEmailAction,
): Promise<void> {
  // The original business source key remains reserved for the valid PENDING
  // event (if any). A hashed derivative is bounded even when an old source key
  // already sits at the public 255-character maximum.
  const sourceHash = createHash('sha256')
    .update(`${sourceKey}\u0000${invalidAction.workflowId}\u0000${invalidAction.actionIndex}`)
    .digest('hex');
  const quarantineSourceKey = `workflow-email-invalid:${sourceHash}`;
  const reason =
    `Workflow ${invalidAction.workflowId} action ${invalidAction.actionIndex}: ${invalidAction.reason}`.slice(
      0,
      500,
    );
  const row = await tx.workflowEmailEvent.upsert({
    where: { sourceKey: quarantineSourceKey },
    create: {
      ticketId: ticket.id,
      eventType,
      sourceKey: quarantineSourceKey,
      actions: [] as unknown as Prisma.InputJsonValue,
      state: 'QUARANTINED',
      lastError: reason,
    },
    update: {},
    select: { ticketId: true, eventType: true, sourceKey: true },
  });
  if (row.ticketId !== ticket.id || row.eventType !== eventType || row.sourceKey !== quarantineSourceKey) {
    throw new Error(`Workflow email invalid-action source conflict for ${quarantineSourceKey}`);
  }
}

@Injectable()
export class WorkflowEmailEventService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowEmailEventService.name);
  private recoveryTimer?: NodeJS.Timeout;
  private healthAlertTimer?: NodeJS.Timeout;
  private recoveryRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    // Mail operations are ticket-scoped. This must be resolved at startup; a
    // missing policy is a deployment error, not a runtime 503 that encourages
    // operators to bypass the durable recovery path.
    private readonly ticketAccess: TicketAccessPolicy,
  ) {}

  onModuleInit(): void {
    // PostgreSQL recovery intentionally works even if Redis/BullMQ is down.  The
    // mail queue is only a wake-up accelerator once an OutboundEmail row exists.
    void this.recoverDueEvents();
    this.recoveryTimer = setInterval(() => void this.recoverDueEvents(), WORKFLOW_EVENT_RECOVERY_MS);
    this.recoveryTimer.unref?.();
    void this.emitHealthAlerts();
    this.healthAlertTimer = setInterval(() => void this.emitHealthAlerts(), WORKFLOW_EVENT_HEALTH_ALERT_MS);
    this.healthAlertTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    if (this.healthAlertTimer) clearInterval(this.healthAlertTimer);
  }

  /** Exposed for deterministic tests and the production recovery supervisor. */
  async recoverDueEvents(): Promise<void> {
    if (this.recoveryRunning) return;
    this.recoveryRunning = true;
    try {
      const now = new Date();
      const due = await this.prisma.workflowEmailEvent.findMany({
        where: {
          OR: [
            { state: 'PENDING' },
            { state: 'RETRY', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
            { state: 'PROCESSING', leaseExpiresAt: { lt: now } },
          ],
        },
        orderBy: { createdAt: 'asc' },
        take: WORKFLOW_EVENT_RECOVERY_BATCH,
        select: { id: true },
      });
      await Promise.all(due.map((event) => this.processEvent(event.id)));
    } catch (err) {
      this.logger.error(`Workflow email event recovery failed (${this.errorKind(err)})`);
    } finally {
      this.recoveryRunning = false;
    }
  }

  /**
   * Metadata-only dashboard list.  The capability is enforced by the controller
   * (`mail.view`), while the relation predicate below is the authoritative
   * per-ticket department fence.  In particular, this list never selects a
   * customer recipient or an immutable message body.
   */
  async listOperatorEvents(query: ListWorkflowEmailEventsDto, actor: AuthStaff) {
    const where = await this.operatorEventWhere(actor, {
      ...(query.state ? { state: query.state } : {}),
      ...(query.ticketId !== undefined ? { ticketId: query.ticketId } : {}),
    });
    const select = {
      id: true,
      ticketId: true,
      eventType: true,
      state: true,
      attempts: true,
      nextAttemptAt: true,
      leaseExpiresAt: true,
      lastError: true,
      processedAt: true,
      createdAt: true,
      updatedAt: true,
      ticket: { select: { id: true, mask: true } },
    } as const;
    const [items, total] = await Promise.all([
      this.prisma.workflowEmailEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select,
      }),
      this.prisma.workflowEmailEvent.count({ where }),
    ]);
    // Construct the response rather than returning Prisma's object wholesale:
    // this remains recipient/body-safe even if a future select or a test double
    // accidentally contains the JSON action snapshot.
    return {
      items: items.map((event) => ({
        id: event.id,
        ticketId: event.ticketId,
        eventType: event.eventType,
        state: event.state,
        attempts: event.attempts,
        nextAttemptAt: event.nextAttemptAt,
        leaseExpiresAt: event.leaseExpiresAt,
        lastError: event.lastError,
        processedAt: event.processedAt,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        ticket: { id: event.ticket.id, mask: event.ticket.mask },
      })),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * An action preview is intentionally detail-only. The query is ticket-scoped
   * before action data is parsed, so a caller without the ticket's department
   * access gets the same 404 as for a non-existent event and cannot read the
   * recipient/body by guessing a CUID.
   */
  async getOperatorEvent(eventId: string, actor: AuthStaff) {
    const event = await this.prisma.workflowEmailEvent.findFirst({
      where: await this.operatorEventWhere(actor, { id: eventId }),
      select: {
        id: true,
        ticketId: true,
        eventType: true,
        sourceKey: true,
        actions: true,
        state: true,
        attempts: true,
        nextAttemptAt: true,
        leaseExpiresAt: true,
        lastError: true,
        processedAt: true,
        createdAt: true,
        updatedAt: true,
        ticket: { select: { id: true, mask: true, subject: true, requesterEmail: true } },
      },
    });
    if (!event) throw new NotFoundException('Workflow email event not found');

    const actions = parseActionSnapshot(event.actions);
    const replayBlockReason = this.replayBlockReason(event.state, actions, event.ticket.requesterEmail);
    return {
      event: {
        id: event.id,
        ticketId: event.ticketId,
        eventType: event.eventType,
        sourceKey: event.sourceKey,
        state: event.state,
        attempts: event.attempts,
        nextAttemptAt: event.nextAttemptAt,
        leaseExpiresAt: event.leaseExpiresAt,
        lastError: event.lastError,
        processedAt: event.processedAt,
        createdAt: event.createdAt,
        updatedAt: event.updatedAt,
        ticket: { id: event.ticket.id, mask: event.ticket.mask, subject: event.ticket.subject },
        // Never return arbitrary JSON.  Only a fully validated immutable snapshot
        // is safe to inspect or use to decide whether replay can proceed.
        actions: actions ?? [],
        snapshotValid: actions !== null,
        replayAllowed: replayBlockReason === null,
        replayBlockReason,
      },
    };
  }

  /**
   * Explicit operator recovery of a terminal event. The immutable action snapshot
   * and source/idempotency keys are deliberately untouched; only the state machine
   * is moved back to PENDING under a version fence. The audit insert is in the
   * same transaction, so a replay never succeeds without its actor and reason.
   */
  async replayOperatorEvent(
    eventId: string,
    dto: ReplayWorkflowEmailEventDto,
    actor: AuthStaff,
  ): Promise<{ replayed: true }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.workflowEmailEvent.findFirst({
        where: await this.operatorEventWhere(actor, { id: eventId }),
        select: {
          id: true,
          ticketId: true,
          state: true,
          updatedAt: true,
          actions: true,
          lastError: true,
          ticket: { select: { requesterEmail: true } },
        },
      });
      if (!current) throw new NotFoundException('Workflow email event not found');
      if (current.state !== 'QUARANTINED') {
        throw new ConflictException('Only quarantined workflow email events can be replayed');
      }
      if (current.updatedAt.getTime() !== dto.expectedUpdatedAt.getTime()) {
        throw new ConflictException('Workflow email event changed; refresh before replaying');
      }

      const safetyBlock = this.replayBlockReason(
        current.state,
        parseActionSnapshot(current.actions),
        current.ticket.requesterEmail,
      );
      if (safetyBlock) {
        // A requeue must never turn an invalid snapshot or a changed requester
        // identity into a second customer-mail attempt.
        throw new BadRequestException(safetyBlock);
      }

      const reset = await tx.workflowEmailEvent.updateMany({
        where: await this.operatorEventWhere(actor, {
          id: eventId,
          state: 'QUARANTINED',
          updatedAt: dto.expectedUpdatedAt,
        }),
        data: {
          state: 'PENDING',
          attempts: 0,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          leaseVersion: { increment: 1 },
          lastError: null,
          processedAt: null,
        },
      });
      if (reset.count !== 1) {
        throw new ConflictException('Workflow email event changed; refresh before replaying');
      }

      await tx.ticketAuditLog.create({
        data: {
          ticketId: current.ticketId,
          staffId: actor.staffId,
          actorType: 'STAFF',
          action: 'WORKFLOW_EMAIL_REPLAY',
          field: 'workflowEmailEventId',
          oldValue: current.lastError?.slice(0, 500) ?? 'QUARANTINED',
          newValue: `PENDING — ${dto.reason}`.slice(0, 500),
        },
      });
      return { ticketId: current.ticketId };
    });

    this.logger.warn(
      `AUDIT workflow email replay event=${eventId} ticket=${result.ticketId} actor=${actor.staffId}`,
    );
    // A synchronous claim is only a wake-up accelerator; processEvent retains its
    // own lease and requester-identity guards, and periodic recovery remains the
    // durable backstop if this process dies immediately after the transaction.
    void this.processEvent(eventId).catch((err: unknown) =>
      this.logger.error(`Workflow email replay wake-up failed for ${eventId} (${this.errorKind(err)})`),
    );
    return { replayed: true };
  }

  /** Ticket-scoped health is safe to expose under the same mail.view capability. */
  async operatorHealth(actor: AuthStaff, now: Date = new Date()): Promise<WorkflowEmailEventHealth> {
    return this.healthForWhere(await this.operatorEventWhere(actor, {}), now);
  }

  private requireTicketAccess(): TicketAccessPolicy {
    return this.ticketAccess;
  }

  /**
   * Workflow events are ticket-owned, not queue-owned. Use TicketAccessPolicy's
   * relation predicate for every read and conditional replay write; the controller
   * separately requires the existing mail.view/mail.replay permissions.
   */
  private async operatorEventWhere(
    actor: AuthStaff,
    base: Prisma.WorkflowEmailEventWhereInput,
  ): Promise<Prisma.WorkflowEmailEventWhereInput> {
    const ticketWhere = await this.requireTicketAccess().ticketWhere(actor);
    return { AND: [base, { ticket: { is: ticketWhere } }] };
  }

  private replayBlockReason(
    state: string,
    actions: WorkflowEmailActionSnapshot[] | null,
    requesterEmail: string | null,
  ): string | null {
    if (state !== 'QUARANTINED') return 'Only quarantined workflow email events can be replayed';
    if (!actions) return 'The immutable workflow email action snapshot is invalid and cannot be replayed';
    const currentRecipient = normalizeEmail(requesterEmail ?? '');
    if (!currentRecipient || actions.some((action) => action.to !== currentRecipient)) {
      return 'Requester email changed or is unavailable; this workflow email event cannot be replayed';
    }
    return null;
  }

  private async healthForWhere(
    where: Prisma.WorkflowEmailEventWhereInput,
    now: Date,
  ): Promise<WorkflowEmailEventHealth> {
    const [grouped, oldestPending, lastProcessed, stalledProcessing] = await Promise.all([
      this.prisma.workflowEmailEvent.groupBy({ by: ['state'], _count: { _all: true }, where }),
      this.prisma.workflowEmailEvent.findFirst({
        where: { AND: [where, { state: { in: ['PENDING', 'RETRY'] } }] },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.workflowEmailEvent.findFirst({
        where: { AND: [where, { state: 'PROCESSED' }] },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
      this.prisma.workflowEmailEvent.count({
        where: { AND: [where, { state: 'PROCESSING', leaseExpiresAt: { lt: now } }] },
      }),
    ]);
    const count = (state: string): number => grouped.find((entry) => entry.state === state)?._count._all ?? 0;
    const byState = {
      pending: count('PENDING'),
      processing: count('PROCESSING'),
      retry: count('RETRY'),
      quarantined: count('QUARANTINED'),
      processed: count('PROCESSED'),
    };
    const alerts: WorkflowEmailEventAlert[] = [];
    if (byState.quarantined > 0) {
      alerts.push({
        severity: 'warning',
        kind: 'workflow_email_quarantine',
        message: `${byState.quarantined} workflow email event(s) are quarantined and require review.`,
      });
    }
    if (stalledProcessing > 0) {
      alerts.push({
        severity: 'warning',
        kind: 'workflow_email_stalled',
        message: `${stalledProcessing} workflow email event(s) are processing past their lease and await reclaim.`,
      });
    }
    if (byState.retry > 0) {
      alerts.push({
        severity: 'warning',
        kind: 'workflow_email_retry',
        message: `${byState.retry} workflow email event(s) are awaiting retry.`,
      });
    }
    if (oldestPending && now.getTime() - oldestPending.createdAt.getTime() > WORKFLOW_EVENT_STALE_MS) {
      alerts.push({
        severity: 'critical',
        kind: 'workflow_email_aged_backlog',
        message: 'The oldest pending workflow email event has waited over 15 minutes.',
      });
    }
    return {
      backlog: byState.pending + byState.retry,
      byState,
      stalledProcessing,
      oldestPendingAt: oldestPending?.createdAt ?? null,
      lastProcessedAt: lastProcessed?.processedAt ?? null,
      alerts,
      checkedAt: now,
    };
  }

  private async emitHealthAlerts(): Promise<void> {
    try {
      const health = await this.healthForWhere({}, new Date());
      for (const alert of health.alerts) {
        const line = `WORKFLOW EMAIL ALERT [${alert.severity}] ${alert.kind}: ${alert.message}`;
        if (alert.severity === 'critical') this.logger.error(line);
        else this.logger.warn(line);
      }
    } catch (err) {
      this.logger.error(`Workflow email health alert emit failed (${this.errorKind(err)})`);
    }
  }

  /** Claim and materialize one durable event.  Safe to call concurrently in many pods. */
  async processEvent(eventId: string): Promise<void> {
    const owner = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + WORKFLOW_EVENT_LEASE_MS);
    const claimed = await this.prisma.workflowEmailEvent.updateMany({
      where: {
        id: eventId,
        OR: [
          { state: 'PENDING' },
          { state: 'RETRY', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
          { state: 'PROCESSING', leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        state: 'PROCESSING',
        attempts: { increment: 1 },
        nextAttemptAt: null,
        leaseOwner: owner,
        leaseExpiresAt,
        leaseVersion: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count !== 1) return;

    const event = await this.prisma.workflowEmailEvent.findUnique({ where: { id: eventId } });
    if (!event || event.state !== 'PROCESSING' || event.leaseOwner !== owner) return;

    try {
      const actions = parseActionSnapshot(event.actions);
      if (!actions) {
        await this.quarantine(event, owner, 'invalid action snapshot');
        return;
      }

      const ticket = await this.prisma.ticket.findUnique({
        where: { id: event.ticketId },
        select: { requesterEmail: true },
      });
      const currentRecipient = normalizeEmail(ticket?.requesterEmail ?? '');
      if (!currentRecipient || actions.some((action) => action.to !== currentRecipient)) {
        // Do not mail an old requester after the ticket identity has changed.
        await this.quarantine(event, owner, 'requester email changed or is unavailable');
        return;
      }

      const outboundIds: string[] = [];
      for (const action of actions) {
        await this.heartbeat(event.id, owner);
        const outbound = await this.mail.createWorkflowTicketEmail({
          ticketId: event.ticketId,
          to: action.to,
          subject: action.subject,
          text: action.text,
          idempotencyKey:
            `workflow-email:${event.sourceKey}:workflow:${action.workflowId}:` +
            `v:${action.workflowVersionMs}:action:${action.actionIndex}`,
        });
        outboundIds.push(outbound.id);
      }

      const settled = await this.prisma.workflowEmailEvent.updateMany({
        where: { id: event.id, state: 'PROCESSING', leaseOwner: owner },
        data: {
          state: 'PROCESSED',
          processedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (settled.count !== 1) return;

      // A failed wake-up is intentionally harmless: MailService scans QUEUED
      // rows from PostgreSQL on startup and periodically.
      for (const outboundId of outboundIds) {
        this.mail
          .enqueueOutbound(outboundId)
          .catch((err: unknown) =>
            this.logger.error(
              `Workflow email outbox wake-up failed for event ${event.id} (${this.errorKind(err)})`,
            ),
          );
      }
    } catch (err) {
      if (err instanceof WorkflowEmailEventLeaseLost) return;
      await this.retryOrQuarantine(event, owner, err);
    }
  }

  private async heartbeat(eventId: string, owner: string): Promise<void> {
    const changed = await this.prisma.workflowEmailEvent.updateMany({
      where: { id: eventId, state: 'PROCESSING', leaseOwner: owner },
      data: { leaseExpiresAt: new Date(Date.now() + WORKFLOW_EVENT_LEASE_MS) },
    });
    if (changed.count !== 1) throw new WorkflowEmailEventLeaseLost();
  }

  private async quarantine(event: WorkflowEmailEvent, owner: string, reason: string): Promise<void> {
    await this.prisma.workflowEmailEvent.updateMany({
      where: { id: event.id, state: 'PROCESSING', leaseOwner: owner },
      data: {
        state: 'QUARANTINED',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: reason.slice(0, 500),
      },
    });
  }

  private async retryOrQuarantine(event: WorkflowEmailEvent, owner: string, err: unknown): Promise<void> {
    const reason = this.errorKind(err);
    const exhausted = event.attempts >= WORKFLOW_EVENT_MAX_ATTEMPTS;
    await this.prisma.workflowEmailEvent.updateMany({
      where: { id: event.id, state: 'PROCESSING', leaseOwner: owner },
      data: exhausted
        ? {
            state: 'QUARANTINED',
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: reason,
          }
        : {
            state: 'RETRY',
            nextAttemptAt: new Date(Date.now() + this.retryDelayMs(event.attempts)),
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: reason,
          },
    });
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(60 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
  }

  private errorKind(err: unknown): string {
    const name = err instanceof Error && err.name ? err.name : 'UnknownError';
    return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 120) || 'UnknownError';
  }
}

function parseActionSnapshot(value: unknown): WorkflowEmailActionSnapshot[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_WORKFLOW_EMAIL_ACTIONS) return null;
  const actionKeys = new Set<string>();
  const parsed: WorkflowEmailActionSnapshot[] = [];

  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const workflowId = raw.workflowId;
    const workflowVersionMs = raw.workflowVersionMs;
    const actionIndex = raw.actionIndex;
    const to = raw.to;
    const subject = raw.subject;
    const text = raw.text;
    if (
      typeof workflowId !== 'number' ||
      !Number.isSafeInteger(workflowId) ||
      typeof workflowVersionMs !== 'number' ||
      !Number.isSafeInteger(workflowVersionMs) ||
      typeof actionIndex !== 'number' ||
      !Number.isSafeInteger(actionIndex) ||
      typeof to !== 'string' ||
      typeof subject !== 'string' ||
      typeof text !== 'string' ||
      !to ||
      to.length > 320 ||
      /[\r\n]/.test(to) ||
      !text.trim() ||
      text.length > MAX_WORKFLOW_EMAIL_TEXT_CHARS
    ) {
      return null;
    }
    const normalizedTo = normalizeEmail(to);
    if (normalizedTo !== to) return null;
    const actionKey = `${workflowId}:${workflowVersionMs}:${actionIndex}`;
    if (actionKeys.has(actionKey)) return null;
    actionKeys.add(actionKey);
    parsed.push({ workflowId, workflowVersionMs, actionIndex, to, subject, text });
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
