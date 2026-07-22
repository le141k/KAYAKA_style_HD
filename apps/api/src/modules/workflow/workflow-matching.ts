import type { Ticket, Workflow } from '@prisma/client';

/**
 * A workflow condition is deliberately kept data-only so the same predicate can
 * be evaluated while a ticket transaction is still open (for durable email
 * snapshots) and later by the legacy in-process workflow executor.
 */
export interface WorkflowCriterion {
  field: string;
  op: string;
  value?: unknown;
}

/**
 * Workflow actions deliberately retain the permissive legacy JSON shape.  New
 * writes are validated in dto.ts, while this type lets the runtime inspect old
 * rows defensively without trusting their contents.
 */
export interface WorkflowAction {
  type: string;
  value?: unknown;
  departmentId?: unknown;
  ownerStaffId?: unknown;
  statusId?: unknown;
  priorityId?: unknown;
  typeId?: unknown;
  tag?: unknown;
  note?: unknown;
}

/** Scalar ticket fields that workflow actions can change and later rules can match. */
export interface WorkflowTicketMutation {
  departmentId?: number;
  ownerStaffId?: number | null;
  statusId?: number;
  priorityId?: number;
  typeId?: number | null;
}

export interface WorkflowActionPlan {
  actions: WorkflowAction[];
  ticketMutation: WorkflowTicketMutation;
  /** The final valid assignee, if this rule leaves the ticket assigned. */
  assignedOwnerId?: number;
  /** Existing/deleted staff references are skipped rather than projected as truth. */
  skippedOwnerIds: number[];
}

export interface WorkflowRuleChainStep {
  workflow: Workflow;
  /** State used to evaluate this rule. */
  before: Ticket;
  actionPlan: WorkflowActionPlan;
  /** State later rules must see after this rule's scalar actions. */
  after: Ticket;
}

export interface WorkflowProjectionOptions {
  /**
   * `assign_staff` is the only scalar action the legacy executor validates
   * before applying. Supplying the same resolver to both callers keeps a bad
   * staff reference from affecting only the durable-email projection.
   */
  canAssignOwner?: (staffId: number) => Promise<boolean>;
}

export function isWorkflowAction(value: unknown): value is WorkflowAction {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)['type'] === 'string'
  );
}

/**
 * Match a workflow against the exact ticket state that caused an event.  Keeping
 * this pure is important: a queued customer-email event must not re-read a
 * ticket after another action has changed it.
 */
export function workflowMatchesTicket(ticket: Ticket, workflow: Pick<Workflow, 'criteria'>): boolean {
  const criteria = workflow.criteria as unknown as WorkflowCriterion[];
  if (!Array.isArray(criteria) || criteria.length === 0) return true;

  return criteria.every((criterion) => {
    const raw = (ticket as unknown as Record<string, unknown>)[criterion.field];
    const fieldValue = String(raw ?? '').toLowerCase();
    const criterionValue = String(criterion.value ?? '').toLowerCase();

    switch (criterion.op) {
      case 'eq':
      case 'is':
        return fieldValue === criterionValue;
      case 'neq':
      case 'is_not':
        return fieldValue !== criterionValue;
      case 'contains':
        return fieldValue.includes(criterionValue);
      case 'not_contains':
        return !fieldValue.includes(criterionValue);
      case 'starts_with':
        return fieldValue.startsWith(criterionValue);
      case 'ends_with':
        return fieldValue.endsWith(criterionValue);
      case 'gt':
        return typeof raw === 'number' && raw > Number(criterion.value);
      case 'lt':
        return typeof raw === 'number' && raw < Number(criterion.value);
      default:
        return false;
    }
  });
}

/**
 * Project the ordered scalar part of the workflow chain without performing any
 * writes.  Both the EventEmitter executor and the transactional workflow-email
 * outbox use this exact function: a status/department/owner change made by an
 * earlier rule is therefore visible to criteria in a later rule.
 */
export async function projectWorkflowRuleChain(
  ticket: Ticket,
  workflows: readonly Workflow[],
  options: WorkflowProjectionOptions = {},
): Promise<WorkflowRuleChainStep[]> {
  let current = ticket;
  const steps: WorkflowRuleChainStep[] = [];
  const ordered = [...workflows]
    .filter((workflow) => workflow.isEnabled)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  for (const workflow of ordered) {
    if (!workflowMatchesTicket(current, workflow)) continue;
    const actionPlan = await planWorkflowActions(workflow.actions, options);
    const after = applyWorkflowTicketMutation(current, actionPlan.ticketMutation);
    steps.push({ workflow, before: current, actionPlan, after });
    current = after;
  }

  return steps;
}

/**
 * Normalize a legacy action array into the one scalar mutation the executor
 * would commit for a matched rule. Invalid scalar values are skipped (rather
 * than coercing them into a different ticket state).
 */
export async function planWorkflowActions(
  value: unknown,
  options: WorkflowProjectionOptions = {},
): Promise<WorkflowActionPlan> {
  const actions = Array.isArray(value) ? value.filter(isWorkflowAction) : [];
  const ticketMutation: WorkflowTicketMutation = {};
  const skippedOwnerIds: number[] = [];
  let assignedOwnerId: number | undefined;

  for (const action of actions) {
    switch (action.type) {
      case 'change_department':
      case 'assign_group': {
        const departmentId = positiveInteger(action.departmentId ?? action.value);
        if (departmentId !== undefined) ticketMutation.departmentId = departmentId;
        break;
      }
      case 'assign':
      case 'change_owner':
      case 'assign_staff': {
        const rawOwner = action.ownerStaffId !== undefined ? action.ownerStaffId : action.value;
        if (rawOwner === null) {
          ticketMutation.ownerStaffId = null;
          assignedOwnerId = undefined;
          break;
        }
        const ownerStaffId = positiveInteger(rawOwner);
        if (ownerStaffId === undefined) break;
        const assignable = options.canAssignOwner ? await options.canAssignOwner(ownerStaffId) : true;
        if (!assignable) {
          skippedOwnerIds.push(ownerStaffId);
          break;
        }
        ticketMutation.ownerStaffId = ownerStaffId;
        assignedOwnerId = ownerStaffId;
        break;
      }
      case 'change_status':
      case 'set_status': {
        const statusId = positiveInteger(action.statusId ?? action.value);
        if (statusId !== undefined) ticketMutation.statusId = statusId;
        break;
      }
      case 'change_priority':
      case 'set_priority': {
        const priorityId = positiveInteger(action.priorityId ?? action.value);
        if (priorityId !== undefined) ticketMutation.priorityId = priorityId;
        break;
      }
      case 'change_type': {
        const rawType = action.typeId !== undefined ? action.typeId : action.value;
        if (rawType === null) {
          ticketMutation.typeId = null;
          break;
        }
        const typeId = positiveInteger(rawType);
        if (typeId !== undefined) ticketMutation.typeId = typeId;
        break;
      }
    }
  }

  return { actions, ticketMutation, assignedOwnerId, skippedOwnerIds };
}

export function applyWorkflowTicketMutation(ticket: Ticket, mutation: WorkflowTicketMutation): Ticket {
  return Object.keys(mutation).length === 0 ? ticket : { ...ticket, ...mutation };
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value.trim())
        ? Number(value)
        : undefined;
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
