import { z } from 'zod';

// ─────────────────── EmailQueue ───────────────────

export const CreateEmailQueueSchema = z.object({
  type: z.enum(['IMAP', 'POP3', 'PIPE']).default('IMAP'),
  emailAddress: z.string().email(),
  host: z.string().default(''),
  port: z.number().int().positive().default(993),
  username: z.string().default(''),
  password: z.string().default(''), // plain-text; stored as passwordEnc (encrypt at-rest TODO)
  useTls: z.boolean().default(true),
  departmentId: z.number().int().positive().nullable().optional(),
  signature: z.string().default(''),
  isEnabled: z.boolean().default(false),
});
export type CreateEmailQueueDto = z.infer<typeof CreateEmailQueueSchema>;

export const UpdateEmailQueueSchema = CreateEmailQueueSchema.partial();
export type UpdateEmailQueueDto = z.infer<typeof UpdateEmailQueueSchema>;
