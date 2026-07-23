import { z } from 'zod';

// ─────────────────── EmailQueue ───────────────────

/**
 * The one canonical IMAP folder representation used at every boundary.  Keep this
 * deliberately ASCII-only: JavaScript String.trim() and PostgreSQL btrim() disagree
 * on Unicode whitespace, which can otherwise make the poller select a different
 * folder from the one the database accepted.  Non-ASCII whitespace is a literal
 * folder-name character; only the explicit six ASCII edge characters are removed.
 */
export const IMAP_MAILBOX_ASCII_EDGE_WHITESPACE = /^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g;
export const MAX_IMAP_MAILBOX_CODE_POINTS = 255;
export const DEFAULT_IMAP_MAILBOX = 'INBOX';

/** Normalize an operator-supplied IMAP folder name into its durable canonical form. */
export function normalizeImapMailbox(value: string): string {
  const mailbox = value.replace(IMAP_MAILBOX_ASCII_EDGE_WHITESPACE, '');
  if (
    mailbox.length === 0 ||
    Array.from(mailbox).length > MAX_IMAP_MAILBOX_CODE_POINTS ||
    /[\r\n]/.test(mailbox) ||
    mailbox.includes('\0')
  ) {
    throw new Error('mailbox must be a non-empty IMAP folder name up to 255 characters');
  }
  return mailbox;
}

/**
 * Validate a mailbox read from durable storage without silently rewriting it. A
 * malformed direct SQL write must halt the queue instead of selecting a subtly
 * different IMAP folder at runtime.
 */
export function readCanonicalImapMailbox(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_IMAP_MAILBOX;
  if (typeof value !== 'string') throw new Error('Configured IMAP mailbox is invalid');
  const canonical = normalizeImapMailbox(value);
  if (canonical !== value) throw new Error('Configured IMAP mailbox is not canonical');
  return canonical;
}

/**
 * A queue must name its IMAP folder explicitly.  We default legacy/new queues to INBOX,
 * but reject control characters and unbounded values before they can reach an IMAP command.
 */
export const ImapMailboxSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeImapMailbox(value);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'mailbox must be a non-empty IMAP folder name up to 255 characters without controls',
    });
    return z.NEVER;
  }
});

/**
 * Capture-only is for an empty, operator-created test folder — never a provider's
 * primary or special-use mailbox. IMAP special-use flags are checked again live at
 * connection time; these common names stop the most dangerous mistakes before any
 * authenticated IMAP session is opened (including Gmail's English system folders).
 */
const KNOWN_UNSAFE_CAPTURE_MAILBOXES = new Set([
  'INBOX',
  'ALL MAIL',
  'ARCHIVE',
  'SENT',
  'SENT MAIL',
  'DRAFTS',
  'TRASH',
  'JUNK',
  'SPAM',
  'IMPORTANT',
  '[GMAIL]/ALL MAIL',
  '[GMAIL]/SENT MAIL',
  '[GMAIL]/DRAFTS',
  '[GMAIL]/TRASH',
  '[GMAIL]/SPAM',
  '[GMAIL]/IMPORTANT',
]);

export function isKnownUnsafeCaptureMailbox(mailbox: string): boolean {
  return KNOWN_UNSAFE_CAPTURE_MAILBOXES.has(mailbox.trim().replace(/\s+/g, ' ').toUpperCase());
}

export const CreateEmailQueueSchema = z.object({
  type: z.enum(['IMAP', 'POP3', 'PIPE']).default('IMAP'),
  emailAddress: z.string().email(),
  host: z.string().default(''),
  port: z.number().int().positive().default(993),
  username: z.string().default(''),
  password: z.string().default(''), // plain-text; stored as passwordEnc (encrypt at-rest TODO)
  useTls: z.boolean().default(true),
  // IMAP uses this exact folder for bootstrap/reconcile/poll locks. It is intentionally
  // independent of the receiving email address, which is still used for routing.
  mailbox: ImapMailboxSchema.default('INBOX'),
  departmentId: z.number().int().positive().nullable().optional(),
  signature: z.string().default(''),
  // Lower values win deterministic routing when one logical message is delivered to
  // multiple enabled queue addresses; queue id is the stable tie-breaker.
  routingPriority: z.number().int().min(0).max(1_000_000).default(100),
  sendAutoresponder: z.boolean().default(false),
  isEnabled: z.boolean().default(false),
});
// Zod supplies routingPriority=100 at the HTTP boundary. Keep it optional in the service
// input too, so internal callers/older seeds remain backward-compatible during rollout.
export type CreateEmailQueueDto = Omit<
  z.infer<typeof CreateEmailQueueSchema>,
  'routingPriority' | 'sendAutoresponder' | 'mailbox'
> & {
  routingPriority?: number;
  sendAutoresponder?: boolean;
  // Optional only for trusted legacy/internal callers. HTTP validation always materialises
  // INBOX; the service defensively normalises this to keep old seeds compatible.
  mailbox?: string;
};

export const UpdateEmailQueueSchema = CreateEmailQueueSchema.partial().extend({
  // Do not let the create-time default silently turn a partial update into an INBOX
  // identity change. Omitted means "leave the selected folder unchanged".
  mailbox: ImapMailboxSchema.optional(),
  // Reject stale queue forms rather than letting a last write silently restore
  // an old address, department or autoresponder policy.
  expectedConfigGeneration: z.number().int().nonnegative(),
});
export type UpdateEmailQueueDto = z.infer<typeof UpdateEmailQueueSchema>;

/** Queue deletion is versioned for the same reason as config writes: a stale tab must not
 * remove a queue that was just repointed/reconciled by another operator. */
export const DeleteEmailQueueSchema = z.object({
  expectedConfigGeneration: z.number().int().nonnegative(),
});
export type DeleteEmailQueueDto = z.infer<typeof DeleteEmailQueueSchema>;

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

// ─────────────────── Captured inbound operator actions ───────────────────

/**
 * Capture-only mode durably stores inbound mail without allowing the drain to create or
 * update tickets. These filters intentionally mirror quarantine observability and only
 * address persisted metadata; neither raw MIME nor an opaque storage key is an API field.
 */
export const ListCapturedInboundSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
  queueId: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(300).optional(),
  messageId: z.string().trim().min(1).max(512).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type ListCapturedInboundDto = z.infer<typeof ListCapturedInboundSchema>;

/**
 * Promotion is deliberately versioned and requires an auditable operator reason. A stale
 * capture view must not promote a delivery that has since been changed by another operator.
 */
export const PromoteCapturedInboundSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  expectedUpdatedAt: z.coerce.date(),
});
export type PromoteCapturedInboundDto = z.infer<typeof PromoteCapturedInboundSchema>;
