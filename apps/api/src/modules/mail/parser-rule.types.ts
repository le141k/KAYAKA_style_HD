/**
 * Type definitions for email parser rule criteria and actions.
 * Stored as JSONB in EmailParserRule.criteria / EmailParserRule.actions.
 */

export type CriterionField = 'subject' | 'sender' | 'sendername' | 'recipient' | 'body';

export type CriterionOp = 'contains' | 'not_contains' | 'eq' | 'starts_with' | 'ends_with' | 'regex';

export interface ParserCriterion {
  field: CriterionField;
  op: CriterionOp;
  value: string;
}

export type ActionType = 'ignore' | 'route_dept' | 'set_priority' | 'assign_staff' | 'add_tag';

export interface ParserAction {
  type: ActionType;
  /** Numeric ID for route_dept, set_priority, assign_staff; tag name for add_tag; omitted for ignore */
  value?: string | number;
}
