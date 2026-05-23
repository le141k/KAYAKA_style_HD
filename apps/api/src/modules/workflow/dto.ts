import { z } from 'zod';

// ─────────────────── Workflow ───────────────────

export const CreateWorkflowSchema = z.object({
  title: z.string().min(1).max(200),
  criteria: z.array(z.unknown()).default([]),
  actions: z.array(z.unknown()).default([]),
  isEnabled: z.boolean().default(true),
  sortOrder: z.number().int().nonnegative().default(0),
});
export type CreateWorkflowDto = z.infer<typeof CreateWorkflowSchema>;

export const UpdateWorkflowSchema = CreateWorkflowSchema.partial();
export type UpdateWorkflowDto = z.infer<typeof UpdateWorkflowSchema>;

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
  replyText: z.string().default(''),
  actions: z.array(z.unknown()).default([]),
  isShared: z.boolean().default(true),
  categoryId: z.number().int().positive().nullable().optional(),
});
export type CreateMacroDto = z.infer<typeof CreateMacroSchema>;

export const UpdateMacroSchema = CreateMacroSchema.partial();
export type UpdateMacroDto = z.infer<typeof UpdateMacroSchema>;
