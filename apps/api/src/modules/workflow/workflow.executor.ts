import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import type { Workflow, Ticket } from '@prisma/client';

/** The shape of a domain event emitted by TicketsService */
interface TicketEvent {
  ticketId: number;
}

/** A single workflow criterion: { field, op, value } */
interface WorkflowCriterion {
  field: string;
  op: 'eq' | 'neq' | 'contains' | 'gt' | 'lt';
  value: unknown;
}

/** A single workflow action */
interface WorkflowAction {
  type:
    | 'change_department'
    | 'change_owner'
    | 'change_status'
    | 'change_priority'
    | 'change_type'
    | 'add_tag'
    | 'add_note';
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

  constructor(private readonly prisma: PrismaService) {}

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

  private async evaluate(ticketId: number, _eventName: string): Promise<void> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) return;

    const workflows = await this.prisma.workflow.findMany({
      where: { isEnabled: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });

    for (const workflow of workflows) {
      if (this.matchesCriteria(ticket, workflow)) {
        await this.applyActions(ticket, workflow);
      }
    }
  }

  private matchesCriteria(ticket: Ticket, workflow: Workflow): boolean {
    const criteria = workflow.criteria as unknown as WorkflowCriterion[];
    if (!Array.isArray(criteria) || criteria.length === 0) return true;

    return criteria.every((c) => {
      const fieldValue = (ticket as Record<string, unknown>)[c.field];
      switch (c.op) {
        case 'eq':
          return fieldValue === c.value;
        case 'neq':
          return fieldValue !== c.value;
        case 'contains':
          return (
            typeof fieldValue === 'string' && fieldValue.toLowerCase().includes(String(c.value).toLowerCase())
          );
        case 'gt':
          return typeof fieldValue === 'number' && fieldValue > (c.value as number);
        case 'lt':
          return typeof fieldValue === 'number' && fieldValue < (c.value as number);
        default:
          return false;
      }
    });
  }

  private async applyActions(ticket: Ticket, workflow: Workflow): Promise<void> {
    const actions = workflow.actions as unknown as WorkflowAction[];
    if (!Array.isArray(actions)) return;

    const ticketUpdate: Partial<Record<string, unknown>> = {};

    for (const action of actions) {
      try {
        switch (action.type) {
          case 'change_department':
            if (action.departmentId) ticketUpdate['departmentId'] = action.departmentId;
            break;
          case 'change_owner':
            ticketUpdate['ownerStaffId'] = action.ownerStaffId ?? null;
            break;
          case 'change_status':
            if (action.statusId) ticketUpdate['statusId'] = action.statusId;
            break;
          case 'change_priority':
            if (action.priorityId) ticketUpdate['priorityId'] = action.priorityId;
            break;
          case 'change_type':
            ticketUpdate['typeId'] = action.typeId ?? null;
            break;
          case 'add_tag':
            if (action.tag) {
              await this.prisma.ticket.update({
                where: { id: ticket.id },
                data: {
                  tags: {
                    connectOrCreate: {
                      where: { name: action.tag },
                      create: { name: action.tag },
                    },
                  },
                },
              });
            }
            break;
          case 'add_note':
            if (action.note) {
              await this.prisma.ticketNote.create({
                data: {
                  ticketId: ticket.id,
                  contents: `[Workflow: ${workflow.title}] ${action.note}`,
                },
              });
            }
            break;
        }
      } catch (err) {
        this.logger.error(
          `Workflow ${workflow.id} action ${action.type} failed on ticket ${ticket.mask}: ${String(err)}`,
        );
      }
    }

    if (Object.keys(ticketUpdate).length > 0) {
      await this.prisma.ticket.update({ where: { id: ticket.id }, data: ticketUpdate });
    }
  }
}
