import { z } from 'zod';

// ─────────────────── create ───────────────────

export const CreateFollowUpSchema = z.object({
  /** When the follow-up reminder is due (ISO date string). */
  dueAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  /** Optional free-text note describing the follow-up. */
  note: z.string().max(2000).optional(),
});
export type CreateFollowUpDto = z.infer<typeof CreateFollowUpSchema>;

// ─────────────────── toggle complete ───────────────────

export const ToggleFollowUpSchema = z.object({
  completed: z.boolean(),
});
export type ToggleFollowUpDto = z.infer<typeof ToggleFollowUpSchema>;
