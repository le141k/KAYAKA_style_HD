import { z } from 'zod';
import { optionalBoolParam } from '../../common/zod-bool.util';

// ─────────────────── create ───────────────────

export const CreateTicketSchema = z.object({
  subject: z.string().min(1).max(500),
  /** Initial post body */
  contents: z.string().min(1),
  isHtml: z.boolean().default(true),
  departmentId: z.number().int().positive(),
  statusId: z.number().int().positive().optional(),
  priorityId: z.number().int().positive().optional(),
  typeId: z.number().int().positive().optional(),
  /** Requester identification — at least one must be provided */
  requesterEmail: z.string().email(),
  requesterName: z.string().default(''),
  /** If provided, links to existing User; otherwise resolved by email */
  userId: z.number().int().positive().optional(),
  ownerStaffId: z.number().int().positive().optional(),
  slaPlanId: z.number().int().positive().optional(),
  customFields: z.record(z.unknown()).default({}),
  tags: z.array(z.string()).default([]),
  creationMode: z.enum(['WEB', 'EMAIL', 'API', 'STAFF', 'ALARIS']).default('STAFF'),
  ipAddress: z.string().default('0.0.0.0'),
  attachmentIds: z.array(z.number().int().positive()).optional(),
  /** CC/BCC recipients stored in TicketRecipient */
  ccEmails: z.array(z.string().email()).optional(),
  bccEmails: z.array(z.string().email()).optional(),
});
export type CreateTicketDto = z.infer<typeof CreateTicketSchema>;

// ─────────────────── reply / note ───────────────────

export const ReplyTicketSchema = z.object({
  contents: z.string().min(1),
  isHtml: z.boolean().default(true),
  /** True = internal note only; stored in TicketNote not TicketPost */
  isNote: z.boolean().default(false),
  isEmailed: z.boolean().default(false),
  isThirdParty: z.boolean().default(false),
  creationMode: z.enum(['WEB', 'EMAIL', 'API', 'STAFF', 'ALARIS']).default('STAFF'),
  ipAddress: z.string().default('0.0.0.0'),
  attachmentIds: z.array(z.number().int().positive()).optional(),
  /** CC/BCC recipients for outbound staff reply email */
  ccEmails: z.array(z.string().email()).optional(),
  bccEmails: z.array(z.string().email()).optional(),
});
export type ReplyTicketDto = z.infer<typeof ReplyTicketSchema>;

// ─────────────────── assign ───────────────────

export const AssignTicketSchema = z.object({
  ownerStaffId: z.number().int().positive().nullable(),
});
export type AssignTicketDto = z.infer<typeof AssignTicketSchema>;

// ─────────────────── status / priority / type ───────────────────

export const ChangeStatusSchema = z.object({ statusId: z.number().int().positive() });
export type ChangeStatusDto = z.infer<typeof ChangeStatusSchema>;

// ─────────────────── bulk actions ───────────────────

export const BulkTicketActionSchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(200),
    action: z.enum(['status', 'assignee', 'unassign']),
    statusId: z.number().int().positive().optional(),
    ownerStaffId: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (d) => {
      if (d.action === 'status') return d.statusId != null;
      if (d.action === 'assignee') return d.ownerStaffId !== undefined;
      return true; // unassign needs no extra field
    },
    { message: 'status action requires statusId; assignee action requires ownerStaffId' },
  );
export type BulkTicketActionDto = z.infer<typeof BulkTicketActionSchema>;

export const ChangePrioritySchema = z.object({ priorityId: z.number().int().positive() });
export type ChangePriorityDto = z.infer<typeof ChangePrioritySchema>;

export const ChangeTypeSchema = z.object({ typeId: z.number().int().positive().nullable() });
export type ChangeTypeDto = z.infer<typeof ChangeTypeSchema>;

// ─────────────────── merge ───────────────────

export const MergeTicketSchema = z.object({
  /** The ticket ID that will SURVIVE (the other ticket is merged into this one). */
  targetTicketId: z.number().int().positive(),
});
export type MergeTicketDto = z.infer<typeof MergeTicketSchema>;

// ─────────────────── tags / watchers ───────────────────

export const TagSchema = z.object({ name: z.string().min(1).max(100) });
export type TagDto = z.infer<typeof TagSchema>;

export const WatcherSchema = z.object({ staffId: z.number().int().positive() });
export type WatcherDto = z.infer<typeof WatcherSchema>;

// ─────────────────── list query ───────────────────

export const ListTicketsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  statusId: z.coerce.number().int().positive().optional(),
  priorityId: z.coerce.number().int().positive().optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  typeId: z.coerce.number().int().positive().optional(),
  ownerStaffId: z.coerce.number().int().positive().optional(),
  /** When true, list only unassigned tickets */
  unassigned: optionalBoolParam(),
  /** When true, list only SLA-breached tickets (unresolved + dueAt in the past). */
  sla_breached: optionalBoolParam(),
  search: z.string().optional(),
  /** Filter by requester user id */
  userId: z.coerce.number().int().positive().optional(),
  isResolved: optionalBoolParam(),
  /** Filter by createdAt range (ISO timestamps) */
  createdAfter: z.coerce.date().optional(),
  createdBefore: z.coerce.date().optional(),
  /** Sort field */
  sortBy: z.enum(['createdAt', 'lastActivityAt', 'lastReplyAt']).default('lastActivityAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type ListTicketsQueryDto = z.infer<typeof ListTicketsQuerySchema>;

// ─────────────────── split ───────────────────

export const SplitTicketSchema = z.object({
  /** IDs of posts to move into the new ticket */
  postIds: z.array(z.number().int().positive()).min(1),
  /** Subject for the new ticket */
  subject: z.string().min(1).max(500),
  /** Optional override of department for the new ticket */
  departmentId: z.number().int().positive().optional(),
});
export type SplitTicketDto = z.infer<typeof SplitTicketSchema>;

// ─────────────────── public submission ───────────────────

export const PublicCreateTicketSchema = z.object({
  subject: z.string().min(1).max(500),
  contents: z.string().min(1),
  requesterEmail: z.string().email(),
  requesterName: z.string().min(1).max(200),
  departmentId: z.number().int().positive().optional(),
  priorityId: z.number().int().positive().optional(),
  typeId: z.number().int().positive().optional(),
  customFields: z.record(z.unknown()).default({}),
  attachmentIds: z.array(z.number().int().positive()).optional(),
});
export type PublicCreateTicketDto = z.infer<typeof PublicCreateTicketSchema>;

// ─────────────────── public reply ───────────────────

export const PublicReplySchema = z.object({
  contents: z.string().min(1),
  /** The requester's email — used to attribute the post to the right user. */
  requesterEmail: z.string().email().optional(),
  attachmentIds: z.array(z.number().int().positive()).optional(),
});
export type PublicReplyDto = z.infer<typeof PublicReplySchema>;

// ─────────────────── apply-macro ───────────────────

export const ApplyMacroSchema = z.object({
  macroId: z.number().int().positive(),
});
export type ApplyMacroDto = z.infer<typeof ApplyMacroSchema>;

// ─────────────────── change department ───────────────────

export const ChangeDepartmentSchema = z.object({
  departmentId: z.number().int().positive(),
});
export type ChangeDepartmentDto = z.infer<typeof ChangeDepartmentSchema>;
