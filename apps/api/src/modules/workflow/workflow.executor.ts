import { Injectable, Logger, Optional } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationService } from '../tickets/notification.service';
import type { Workflow, Ticket } from '@prisma/client';

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

/** A single workflow criterion. Accepts both the admin-UI vocab (is/is_not/
 *  starts_with/ends_with/not_contains, value is a string) and the legacy vocab. */
interface WorkflowCriterion {
  field: string;
  op: string;
  value?: unknown;
}

/** A single workflow action. The admin UI emits { type, value } where value is a
 *  string; legacy/typed actions carry explicit id fields. Both are supported. */
interface WorkflowAction {
  type: string;
  value?: string;
  departmentId?: number;
  ownerStaffId?: number;
  statusId?: number;
  priorityId?: number;
  typeId?: number;
  tag?: string;
  note?: string;
}

@Injectable()
export class WorkflowExecutor {
  private readonly logger = new Logger(WorkflowExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly mail?: MailService,
    @Optional() private readonly notifications?: NotificationService,
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

      for (const workflow of workflows) {
        if (this.matchesCriteria(ticket, workflow)) {
          const changed = await this.applyActions(ticket, workflow);
          // A5: re-fetch between evaluations so the next workflow matches against
          // the UPDATED ticket, not the stale snapshot taken at the top.
          if (changed) {
            const fresh = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
            if (!fresh) return;
            ticket = fresh;
          }
        }
      }
    } finally {
      const d = (this.inFlightDepth.get(ticketId) ?? 1) - 1;
      if (d <= 0) this.inFlightDepth.delete(ticketId);
      else this.inFlightDepth.set(ticketId, d);
    }
  }

  private matchesCriteria(ticket: Ticket, workflow: Workflow): boolean {
    const criteria = workflow.criteria as unknown as WorkflowCriterion[];
    if (!Array.isArray(criteria) || criteria.length === 0) return true;

    return criteria.every((c) => {
      const raw = (ticket as Record<string, unknown>)[c.field];
      const fv = String(raw ?? '').toLowerCase();
      const cv = String(c.value ?? '').toLowerCase();
      switch (c.op) {
        case 'eq':
        case 'is':
          return fv === cv;
        case 'neq':
        case 'is_not':
          return fv !== cv;
        case 'contains':
          return fv.includes(cv);
        case 'not_contains':
          return !fv.includes(cv);
        case 'starts_with':
          return fv.startsWith(cv);
        case 'ends_with':
          return fv.endsWith(cv);
        case 'gt':
          return typeof raw === 'number' && raw > Number(c.value);
        case 'lt':
          return typeof raw === 'number' && raw < Number(c.value);
        default:
          return false;
      }
    });
  }

  /** Returns true if the ticket's matchable state changed (so the caller re-fetches). */
  private async applyActions(ticket: Ticket, workflow: Workflow): Promise<boolean> {
    const actions = workflow.actions as unknown as WorkflowAction[];
    if (!Array.isArray(actions)) return false;

    const ticketUpdate: Partial<Record<string, unknown>> = {};
    // Track a real owner assignment so we can notify + audit after the update.
    let assignedOwnerId: number | null = null;
    // Tag mutations also change matchable state even though they bypass ticketUpdate.
    let mutated = false;

    for (const action of actions) {
      try {
        // Effective scalar value: legacy typed field OR the UI's string `value`.
        const num = (legacy?: number) => legacy ?? (action.value != null ? Number(action.value) : undefined);
        const str = (legacy?: string) => legacy ?? action.value;
        switch (action.type) {
          case 'change_department':
          case 'assign_group': // UI label; ticket has no group → treat as department
            if (num(action.departmentId)) ticketUpdate['departmentId'] = num(action.departmentId);
            break;
          // `assign` is the macro-builder vocab; `assign_staff`/`change_owner` the
          // workflow vocab — unify so an "assign" action actually assigns.
          case 'assign':
          case 'change_owner':
          case 'assign_staff': {
            const owner = num(action.ownerStaffId);
            if (owner == null || Number.isNaN(owner)) {
              ticketUpdate['ownerStaffId'] = null; // explicit unassign
            } else if (await this.prisma.staff.findUnique({ where: { id: owner } })) {
              ticketUpdate['ownerStaffId'] = owner;
              assignedOwnerId = owner;
            } else {
              this.logger.warn(`Workflow ${workflow.id}: skipped assign — staff ${owner} not found`);
            }
            break;
          }
          case 'change_status':
          case 'set_status':
            if (num(action.statusId)) ticketUpdate['statusId'] = num(action.statusId);
            break;
          case 'change_priority':
          case 'set_priority':
            if (num(action.priorityId)) ticketUpdate['priorityId'] = num(action.priorityId);
            break;
          case 'change_type':
            ticketUpdate['typeId'] = num(action.typeId) ?? null;
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
            const to = ticket.requesterEmail;
            if (!this.mail || !to) {
              this.logger.warn(
                `Workflow ${workflow.id}: send_email skipped (no mail service or requester email)`,
              );
              break;
            }
            const body = str(action.note) || str(action.value) || `Обновление по обращению ${ticket.mask}.`;
            await this.mail.send({
              to,
              subject: `[${ticket.mask}] ${ticket.subject}`,
              text: body,
            });
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

    if (Object.keys(ticketUpdate).length > 0) {
      await this.prisma.ticket.update({ where: { id: ticket.id }, data: ticketUpdate });
      mutated = true;
    }

    // A workflow assignment must notify the assignee + leave an audit trail, just
    // like a manual assign() (H8-1). The workflow has no staff actor → SYSTEM.
    if (assignedOwnerId != null) {
      await this.prisma.ticketAuditLog.create({
        data: {
          ticketId: ticket.id,
          staffId: null,
          actorType: 'SYSTEM',
          action: 'ASSIGN',
          field: 'ownerStaffId',
          oldValue: ticket.ownerStaffId?.toString() ?? null,
          newValue: assignedOwnerId.toString(),
        },
      });
      if (this.notifications) {
        await this.notifications
          .notifyOnAssign(ticket.id, assignedOwnerId)
          .catch((err: unknown) =>
            this.logger.error(`Workflow ${workflow.id} assign notification failed: ${String(err)}`),
          );
      }
    }

    return mutated;
  }
}
