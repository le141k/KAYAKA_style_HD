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

// ─────────────────── Cutover / reconcile ───────────────────
//
// Explicit, audited transition off the legacy Setting-based IMAP cursor onto the
// InboundDelivery ledger cursor. A queue halted by the upgrade migration
// (NEEDS_RECONCILIATION) resumes ONLY through this action:
//   RESUME_MIGRATED — carry the legacy `imap/state:<id>` cursor (UIDVALIDITY + watermark,
//                     rewound past still-pending UIDs) forward onto the ledger cursor.
//   FROM_NOW        — DISCARD the legacy cursor and start at the current high-water UID
//                     (imports nothing). Can skip mail that arrived unprocessed → requires
//                     an explicit confirm + reason for the audit trail.
//   BACKFILL        — re-bootstrap and additionally ingest up to `backfillLimit` recent
//                     existing messages.
export const ReconcileEmailQueueSchema = z
  .object({
    mode: z.enum(['RESUME_MIGRATED', 'FROM_NOW', 'BACKFILL']),
    reason: z.string().trim().min(1).max(500).optional(),
    confirm: z.boolean().optional(),
    backfillLimit: z.number().int().nonnegative().max(100_000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'FROM_NOW') {
      if (v.confirm !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confirm'],
          message:
            'FROM_NOW discards the migrated cursor and may skip mail that arrived unprocessed — set confirm=true to proceed',
        });
      }
      if (!v.reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'FROM_NOW requires a reason for the audit trail',
        });
      }
    }
  });
export type ReconcileEmailQueueDto = z.infer<typeof ReconcileEmailQueueSchema>;
