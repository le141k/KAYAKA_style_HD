import { z } from 'zod';

// ─────────────────── Log a time entry ───────────────────

export const LogTimeSchema = z.object({
  minutes: z.number().int().positive(),
  note: z.string().max(2000).optional(),
  spentAt: z.string().datetime().optional(),
});
export type LogTimeDto = z.infer<typeof LogTimeSchema>;
