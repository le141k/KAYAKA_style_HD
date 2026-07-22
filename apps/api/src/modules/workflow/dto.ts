import { z } from 'zod';

// ─────────────────── Workflow ───────────────────

export const MAX_WORKFLOW_ACTIONS = 50;
export const MAX_WORKFLOW_EMAIL_TEXT_CHARS = 50_000;

/**
 * Keep non-email workflow action payloads backward-compatible, but never admit
 * an unrenderable customer send_email action. Runtime also quarantines old DB
 * rows defensively; this schema prevents new corruption at the API boundary.
 */
export const WorkflowActionSchema = z
  .object({
    type: z.string().trim().min(1).max(80),
    value: z.unknown().optional(),
    note: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((action, ctx) => {
    if (action.type !== 'send_email') return;
    const note = typeof action.note === 'string' ? action.note.trim() : '';
    const value = typeof action.value === 'string' ? action.value.trim() : '';
    const body = note || value;
    if (!body) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: 'send_email requires a non-empty string value or note',
      });
      return;
    }
    if (body.length > MAX_WORKFLOW_EMAIL_TEXT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        path: ['value'],
        maximum: MAX_WORKFLOW_EMAIL_TEXT_CHARS,
        inclusive: true,
        type: 'string',
        message: `send_email body must be at most ${MAX_WORKFLOW_EMAIL_TEXT_CHARS} characters`,
      });
    }
  });

export const WorkflowActionsSchema = z.array(WorkflowActionSchema).max(MAX_WORKFLOW_ACTIONS);

export const CreateWorkflowSchema = z.object({
  title: z.string().min(1).max(200),
  criteria: z.array(z.unknown()).default([]),
  actions: WorkflowActionsSchema.default([]),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().nonnegative().default(0),
});
export type CreateWorkflowDto = z.infer<typeof CreateWorkflowSchema>;

export const UpdateWorkflowSchema = CreateWorkflowSchema.partial();
export type UpdateWorkflowDto = z.infer<typeof UpdateWorkflowSchema>;

// ─────────────────── Workflow email event operations ───────────────────

/** Metadata-only operator list. Customer recipient/body are never returned here. */
export const ListWorkflowEmailEventsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  state: z.enum(['PENDING', 'PROCESSING', 'PROCESSED', 'RETRY', 'QUARANTINED']).optional(),
  ticketId: z.coerce.number().int().positive().optional(),
});
export type ListWorkflowEmailEventsDto = z.infer<typeof ListWorkflowEmailEventsSchema>;

/** A manual replay is both version-fenced and auditable. */
export const ReplayWorkflowEmailEventSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  expectedUpdatedAt: z.coerce.date(),
});
export type ReplayWorkflowEmailEventDto = z.infer<typeof ReplayWorkflowEmailEventSchema>;

// ─────────────────── MacroCategory ───────────────────

export const CreateMacroCategorySchema = z.object({
  title: z.string().min(1).max(200),
  parentId: z.number().int().positive().nullable().optional(),
});
export type CreateMacroCategoryDto = z.infer<typeof CreateMacroCategorySchema>;

export const UpdateMacroCategorySchema = CreateMacroCategorySchema.partial();
export type UpdateMacroCategoryDto = z.infer<typeof UpdateMacroCategorySchema>;

// ─────────────────── Macro ───────────────────

export const CreateMacroSchema = z.object({
  title: z.string().min(1).max(200),
  replyText: z.string().max(50_000).default(''),
  actions: z.array(z.unknown()).max(50).default([]),
  isShared: z.boolean().default(true),
  categoryId: z.number().int().positive().nullable().optional(),
});
export type CreateMacroDto = z.infer<typeof CreateMacroSchema>;

export const UpdateMacroSchema = CreateMacroSchema.partial();
export type UpdateMacroDto = z.infer<typeof UpdateMacroSchema>;
