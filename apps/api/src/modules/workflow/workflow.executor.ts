import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationService } from '../tickets/notification.service';
import type { Workflow, Ticket } from '@prisma/client';
import { projectWorkflowRuleChain, type WorkflowActionPlan } from './workflow-matching';

/** Domain event WorkflowService emits after any workflow write, to bust the cache below. */
export const WORKFLOW_CHANGED_EVENT = 'workflow.changed';
/** Short TTL: bounds staleness if an invalidation event is ever missed. */
const WORKFLOW_CACHE_TTL_MS = 10_000;
/** A5(iii): hard cap on re-entrant evaluations for one ticket — stops a
 *  status→status (or future event-emitting) workflow from looping forever. */
const MAX_WORKFLOW_DEPTH = 5;

/** The shape of a domain event emitted by TicketsService */
interface TicketEvent {
  ticketId: number;
}

@Injectable()
export class WorkflowExecutor {
  private readonly logger = new Logger(WorkflowExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    // Required production dependency. Workflow assignment must not commit with
    // a silent no-op notification path; its outbox command is part of the same
    // transaction as the owner update and audit record below.
    private readonly notifications: NotificationService,
  ) {}

  // C3: cache the enabled-workflows list — it was queried on EVERY ticket event.
  // Invalidated on any workflow write (event below) with a short TTL as a backstop.
  private workflowCache: { data: Workflow[]; expiresAt: number } | null = null;

  @OnEvent(WORKFLOW_CHANGED_EVENT)
  invalidateWorkflowCache(): void {
    this.workflowCache = null;
  }

  private async getEnabledWorkflows(): Promise<Workflow[]> {
    const now = Date.now();
    if (this.workflowCache && this.workflowCache.expiresAt > now) {
      return this.workflowCache.data;
    }
    const data = await this.prisma.workflow.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    this.workflowCache = { data, expiresAt: now + WORKFLOW_CACHE_TTL_MS };
    return data;
  }

  @OnEvent('ticket.created')
  async onTicketCreated(payload: TicketEvent): Promise<void> {
    await this.evaluate(payload.ticketId, 'ticket.created');
  }

  @OnEvent('ticket.replied')
  async onTicketReplied(payload: TicketEvent): Promise<void> {
    await this.evaluate(payload.ticketId, 'ticket.replied');
  }

  @OnEvent('ticket.status_changed')
  async onTicketStatusChanged(payload: TicketEvent): Promise<void> {
    await this.evaluate(payload.ticketId, 'ticket.status_changed');
  }

  // A5(iii): per-ticket re-entrancy depth. Guards against a workflow chain that
  // (now or via a future event-emitting action) re-triggers evaluation of the
  // same ticket without bound.
  private readonly inFlightDepth = new Map<number, number>();

  private async evaluate(ticketId: number, _eventName: string): Promise<void> {
    const depth = this.inFlightDepth.get(ticketId) ?? 0;
    if (depth >= MAX_WORKFLOW_DEPTH) {
      this.logger.warn(`Workflow recursion guard: ticket ${ticketId} hit depth ${depth} — stopping`);
      return;
    }
    this.inFlightDepth.set(ticketId, depth + 1);
    try {
      let ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
      if (!ticket) return;

      const workflows = await this.getEnabledWorkflows();
      const ownerAvailability = new Map<number, boolean>();
      const canAssignOwner = async (staffId: number): Promise<boolean> => {
        const cached = ownerAvailability.get(staffId);
        if (cached !== undefined) return cached;
        const exists = Boolean(await this.prisma.staff.findUnique({ where: { id: staffId } }));
        ownerAvailability.set(staffId, exists);
        return exists;
      };

      for (const workflow of workflows) {
        // Keep the same projection function as WorkflowEmailEventService.  Using
        // the current persisted ticket for each one-rule projection preserves the
        // existing re-fetch boundary while ensuring its scalar action vocabulary
        // and later-rule criteria are identical to the durable email planner.
        const [step] = await projectWorkflowRuleChain(ticket, [workflow], { canAssignOwner });
        if (!step) continue;
        const changed = await this.applyActions(ticket, workflow, step.actionPlan);
        // A5: re-fetch between evaluations so the next workflow matches against
        // the UPDATED ticket, not the stale snapshot taken at the top.
        if (changed) {
          const fresh = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
          if (!fresh) return;
          ticket = fresh;
        }
      }
    } finally {
      const d = (this.inFlightDepth.get(ticketId) ?? 1) - 1;
      if (d <= 0) this.inFlightDepth.delete(ticketId);
      else this.inFlightDepth.set(ticketId, d);
    }
  }

  /** Returns true if the ticket's matchable state changed (so the caller re-fetches). */
  private async applyActions(
    ticket: Ticket,
    workflow: Workflow,
    actionPlan: WorkflowActionPlan,
  ): Promise<boolean> {
    const actions = actionPlan.actions;
    // Tag mutations also change matchable state even though they bypass ticketUpdate.
    let mutated = false;

    for (const staffId of actionPlan.skippedOwnerIds) {
      this.logger.warn(`Workflow ${workflow.id}: skipped assign — staff ${staffId} not found`);
    }

    for (const action of actions) {
      try {
        const str = (legacy?: unknown): string | undefined =>
          typeof legacy === 'string' ? legacy : typeof action.value === 'string' ? action.value : undefined;
        switch (action.type) {
          // Scalar actions are applied once from the shared rule-chain plan
          // below. Re-parsing them here would let legacy/UI representations
          // diverge from the durable workflow-email snapshot.
          case 'change_department':
          case 'assign_group':
          case 'assign':
          case 'change_owner':
          case 'assign_staff':
          case 'change_status':
          case 'set_status':
          case 'change_priority':
          case 'set_priority':
          case 'change_type':
            break;
          case 'add_tag': {
            const tag = str(action.tag);
            if (tag) {
              await this.prisma.ticket.update({
                where: { id: ticket.id },
                data: { tags: { connectOrCreate: { where: { name: tag }, create: { name: tag } } } },
              });
              mutated = true;
            }
            break;
          }
          case 'remove_tag': {
            const tag = str(action.tag);
            if (tag) {
              await this.prisma.ticket.update({
                where: { id: ticket.id },
                data: { tags: { disconnect: { name: tag } } },
              });
              mutated = true;
            }
            break;
          }
          case 'add_note':
            if (str(action.note)) {
              await this.prisma.ticketNote.create({
                data: { ticketId: ticket.id, contents: `[Workflow: ${workflow.title}] ${str(action.note)}` },
              });
            }
            break;
          case 'send_email': {
            // Customer email is materialized solely by WorkflowEmailEventService.
            // That event is inserted in the same ticket transaction as the
            // triggering post/status change, so this in-memory listener must never
            // send a second copy or become an availability dependency.
            this.logger.debug(`Workflow ${workflow.id}: send_email delegated to durable event outbox`);
            break;
          }
          default:
            this.logger.warn(`Workflow ${workflow.id}: unknown action type "${action.type}"`);
        }
      } catch (err) {
        this.logger.error(
          `Workflow ${workflow.id} action ${action.type} failed on ticket ${ticket.mask}: ${String(err)}`,
        );
      }
    }

    if (Object.keys(actionPlan.ticketMutation).length > 0) {
      if (actionPlan.assignedOwnerId == null) {
        await this.prisma.ticket.update({ where: { id: ticket.id }, data: actionPlan.ticketMutation });
      } else {
        // The owner update, audit row and durable internal-notification command
        // form one business action. A crash/failure can therefore produce either
        // all three persisted records or none — never an assigned ticket with a
        // missing alert, and never an alert for a rolled-back assignment.
        const notificationId = await this.prisma.$transaction(async (tx) => {
          const updatedTicket = await tx.ticket.update({
            where: { id: ticket.id },
            data: actionPlan.ticketMutation,
          });
          const audit = await tx.ticketAuditLog.create({
            data: {
              ticketId: ticket.id,
              staffId: null,
              actorType: 'SYSTEM',
              action: 'ASSIGN',
              field: 'ownerStaffId',
              oldValue: ticket.ownerStaffId?.toString() ?? null,
              newValue: actionPlan.assignedOwnerId!.toString(),
            },
            select: { id: true },
          });
          return this.notifications.queueAssignmentNotification(
            tx,
            updatedTicket,
            actionPlan.assignedOwnerId!,
            `audit:${audit.id}`,
          );
        });
        if (notificationId) this.notifications.wakeCommittedNotifications([notificationId]);
      }
      mutated = true;
    }

    return mutated;
  }
}
