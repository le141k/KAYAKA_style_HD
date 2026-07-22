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
  // Lower values win deterministic routing when one logical message is delivered to
  // multiple enabled queue addresses; queue id is the stable tie-breaker.
  routingPriority: z.number().int().min(0).max(1_000_000).default(100),
  isEnabled: z.boolean().default(false),
});
// Zod supplies routingPriority=100 at the HTTP boundary. Keep it optional in the service
// input too, so internal callers/older seeds remain backward-compatible during rollout.
export type CreateEmailQueueDto = Omit<z.infer<typeof CreateEmailQueueSchema>, 'routingPriority'> & {
  routingPriority?: number;
};

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
    // The operator UI reads this from the queue returned by the server and sends it
    // back unchanged.  Requiring it turns a stale tab / double click into HTTP 409
    // rather than a last-write-wins cursor transition.
    expectedCursorGeneration: z.number().int().nonnegative(),
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
    if (v.mode === 'BACKFILL' && (v.backfillLimit === undefined || v.backfillLimit < 1)) {
      // A 0/absent backfill imports nothing → identical to FROM_NOW's skip-unprocessed-mail
      // effect, which must go through FROM_NOW's confirm+reason gate. So BACKFILL must
      // actually backfill (limit ≥ 1); use FROM_NOW to intentionally discard-and-skip.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backfillLimit'],
        message:
          'BACKFILL requires backfillLimit ≥ 1 (a 0/absent limit imports nothing — use FROM_NOW with confirm+reason to intentionally skip)',
      });
    }
  });
export type ReconcileEmailQueueDto = z.infer<typeof ReconcileEmailQueueSchema>;

// ─────────────────── Inbound quarantine operator actions ───────────────────

export const ListQuarantinedInboundSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  queueId: z.coerce.number().int().positive().optional(),
  // `reason` filters the safe persisted failure summary; raw MIME is never returned.
  reason: z.string().trim().min(1).max(300).optional(),
  messageId: z.string().trim().min(1).max(512).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListQuarantinedInboundDto = z.infer<typeof ListQuarantinedInboundSchema>;

/** A replay is a business-changing action, never a button with an empty audit trail. */
export const ReplayQuarantinedInboundSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  // The UI sends the row version it inspected. A changed row is a 409, never a
  // second replay that races an already-running operator action.
  expectedUpdatedAt: z.coerce.date(),
});
export type ReplayQuarantinedInboundDto = z.infer<typeof ReplayQuarantinedInboundSchema>;
