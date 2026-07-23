import { z } from 'zod';

/** Validated runtime configuration, sourced from TELECOM_HD_* env vars. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TELECOM_HD_API_PORT: z.coerce.number().default(4000),
  TELECOM_HD_PUBLIC_URL: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  TELECOM_HD_JWT_ACCESS_SECRET: z.string().min(32),
  TELECOM_HD_JWT_REFRESH_SECRET: z.string().min(32),
  TELECOM_HD_JWT_ACCESS_TTL: z.coerce.number().default(900),
  TELECOM_HD_JWT_REFRESH_TTL: z.coerce.number().default(2592000),
  TELECOM_HD_SMTP_HOST: z.string().default('localhost'),
  TELECOM_HD_SMTP_PORT: z.coerce.number().default(1025),
  // NB: z.coerce.boolean() treats the string "false" as truthy → parse explicitly.
  TELECOM_HD_SMTP_SECURE: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  // SMTP auth — optional (MailHog needs none); a real relay requires both.
  TELECOM_HD_SMTP_USER: z.string().optional(),
  TELECOM_HD_SMTP_PASSWORD: z.string().optional(),
  TELECOM_HD_MAIL_FROM: z.string().default('23 Telecom Help Desk <support@23telecom.example>'),
  // Physical outbound-delivery kill switch. Keep this false during every initial
  // production/capture rollout: a configured SMTP relay must not recover and send
  // any pre-existing durable outbox rows until an operator explicitly enables it.
  TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  // Optional attended-canary fence for the durable SMTP worker. When set, runtime
  // may deliver only this one Prisma CUID outbox command; all other queued rows
  // stay untouched. Leave blank for normal operation.
  TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z
        .string()
        .trim()
        .regex(/^c[a-z0-9]{24}$/, 'must be a Prisma CUID')
        .optional(),
    )
    .optional(),
  // Pair this with TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID during an attended SMTP
  // canary. Runtime compares the normalized durable recipient snapshot before
  // it sends; leave both values blank for normal operation.
  TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: z
    .preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
      z.string().trim().email('must be a mailbox address').optional(),
    )
    .optional(),
  TELECOM_HD_LOG_LEVEL: z.string().default('info'),
  // Shared-secret for the Alaris webhook. Must be at least 32 chars so it carries
  // enough entropy to resist guessing; the default below is a 32-char dev value.
  // Generate a strong one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  TELECOM_HD_ALARIS_WEBHOOK_SECRET: z.string().min(32).default('alaris-dev-secret-change-me-0000'),
  // Shared-secret for the inbound mail webhook (POST /api/inbound/pipe) used by an
  // MTA/PIPE delivery script. Same entropy requirement as the Alaris secret.
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  TELECOM_HD_INBOUND_WEBHOOK_SECRET: z.string().min(32).default('inbound-dev-secret-change-me-0000'),
  TELECOM_HD_UPLOAD_DIR: z.string().min(1).default('/app/uploads'),
  TELECOM_HD_UPLOAD_MAX_SIZE_MB: z.coerce.number().int().min(1).max(25).default(25),
  TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB: z.coerce.number().int().min(1).max(50).default(50),
  // Multipart envelope included. Keep this slightly above the aggregate file-byte
  // limit and at/below the reverse-proxy request-body limit (55 MiB in production).
  TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB: z.coerce.number().int().min(1).max(55).default(51),
  // Max accepted inbound message size (MB): the PIPE webhook body cap AND the IMAP
  // fetch ceiling. Must be >= the largest real email+attachments; align with the
  // reverse proxy / MTA limit. Reused by the ledger accept path (byte-safe PIPE).
  TELECOM_HD_INBOUND_MAX_SIZE_MB: z.coerce.number().int().min(1).max(35).default(35),
  TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  // Absolute, cross-channel cap for unclaimed rows. Public/client/staff/inbound
  // orphan uploads share the same database-backed capacity boundary.
  TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT: z.coerce.number().int().min(100).max(5000).default(2000),
  TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB: z.coerce.number().int().min(100).max(10240).default(2048),
  // Refuse new writes when the upload filesystem would fall below this reserve.
  // The 5 GiB default remains below the deployment host's 15 GiB launch gate.
  TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB: z.coerce.number().int().min(256).max(10240).default(5120),
  // Bound each cleanup pass independently of the absolute outstanding-orphan cap.
  // A short interval drains backlog without letting maintenance monopolize the API.
  TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS: z.coerce.number().int().min(1).max(5000).default(1000),
  TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS: z.coerce.number().int().min(10).max(300).default(120),
  TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  TELECOM_HD_PUBLIC_UPLOAD_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  // Separate from both the read-capable client portal and anonymous upload. This
  // lets operations stop verified-client writes without taking ticket reads down.
  TELECOM_HD_CLIENT_UPLOAD_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  TELECOM_HD_TURNSTILE_SECRET: z.string().optional(),
  TELECOM_HD_TURNSTILE_HOSTNAME: z.string().optional(),
  TELECOM_HD_CLAMAV_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  TELECOM_HD_CLAMAV_HOST: z.string().default('clamav'),
  TELECOM_HD_CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  TELECOM_HD_CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  // Global IMAP poller switch. When false (default) the poller never connects; the
  // inbound webhook (POST /api/inbound/pipe) and the ledger drain still run. Turn on
  // ONLY once at least one IMAP EmailQueue is configured and reconciled.
  TELECOM_HD_IMAP_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  // Master inbound-delivery gate. Unlike TELECOM_HD_IMAP_ENABLED this closes BOTH
  // delivery transports: background IMAP connection/poll/accept is stopped, PIPE is
  // rejected before its body parser, and already-accepted ledger rows are left untouched
  // for a later, explicitly enabled drain. An operator may still take an explicit IMAP
  // reconcile baseline while closed; that read-only mailbox step never accepts or routes
  // a message and prepares a canary safely. Keep the gate false for every code/migration
  // deploy; turn it on only for an attended inbound canary after the cutover runbook gates.
  TELECOM_HD_INBOUND_DELIVERY_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  // Optional attended-canary fence for normal (non-capture) inbound delivery.
  // It is paired with the immutable captured-delivery id below: the normal
  // canary promotes and processes exactly one previously reviewed CAPTURED row,
  // rather than polling a fresh mailbox or draining a queue backlog. Leave both
  // blank for normal operation.
  TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: z
    .preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    )
    .optional(),
  TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: z
    .preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    )
    .optional(),
  // Capture-only is a separate, mutually-exclusive acceptance mode for one explicitly
  // selected TLS-enabled IMAP test queue. It durably stores raw RFC822 mail as CAPTURED, but never lets
  // the ledger drain parse, route, create tickets/posts, or enqueue mail; PIPE is rejected. It is not a
  // shortcut to enable normal delivery: normal delivery must remain false while capture
  // is active, and captured rows require an explicit audited operator promotion later.
  TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
  // Bound capture-only IMAP acceptance to one known EmailQueue. This prevents a test flag
  // from consuming or advancing arbitrary production mailboxes; runtime also refuses PIPE.
  TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: z
    .preprocess(
      (v) => (v === '' || v === undefined ? undefined : v),
      z.coerce.number().int().positive().optional(),
    )
    .optional(),
  // A capture-only test is deliberately tiny. Keeping a hard durable count bound
  // prevents an unattended/repeated IMAP poll from retaining an entire mailbox as
  // raw MIME merely because capture mode was left enabled. The default permits one
  // reviewed message. Capture-only is deliberately not a bulk-import feature: any
  // wider exercise needs a separately reviewed normal-delivery test plan.
  TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: z.coerce.number().int().min(1).max(100).default(1),
  // IMAP first-connect baseline policy. FROM_NOW (default) records the current
  // high-water UID and imports nothing; BACKFILL additionally ingests up to
  // TELECOM_HD_IMAP_BACKFILL_LIMIT most-recent existing messages. Chosen explicitly
  // so a fresh connect can never silently import the whole historical mailbox.
  TELECOM_HD_IMAP_BOOTSTRAP_POLICY: z.enum(['FROM_NOW', 'BACKFILL']).default('FROM_NOW'),
  // A global backfill is deliberately bounded. Per-queue BACKFILL remains an
  // explicit reconcile action, but a typo in the environment must never turn a
  // first production connect into an unbounded historical import.
  TELECOM_HD_IMAP_BACKFILL_LIMIT: z.coerce.number().int().min(0).max(10_000).default(0),
  // Max processing attempts before an inbound delivery is QUARANTINED (raw MIME is
  // always retained for replay — a quarantine never discards a message).
  TELECOM_HD_INBOUND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  // Raw-MIME retention (days). A terminal PROCESSED/SKIPPED delivery older than this has its
  // inline raw MIME pruned (metadata + contentHash kept) to bound the ledger's on-disk growth.
  // QUARANTINED and CAPTURED deliveries are NEVER pruned (raw MIME is needed to replay/review).
  // Capture-only also disables the global retention/reaper timers entirely. 0 disables pruning.
  TELECOM_HD_INBOUND_RAW_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  // 256-bit AES key for field-level encryption (IMAP passwords, etc.). It remains
  // optional in dev/test so local fixtures can run without secret material, but
  // production startup requires it below.
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  TELECOM_HD_FIELD_ENCRYPTION_KEY: z.string().optional(),
  // Fail-closed gate for the anonymous client portal (GOAL_PUBLIC_SECURITY S2-1).
  // The legacy "email-as-password" ticket routes and public upload are an IDOR and
  // must stay unreachable in PRODUCTION until the verified client-session flow (S2)
  // and public-abuse controls (S4) land. Defaults CLOSED; dev/test are unaffected.
  // NB: z.coerce.boolean() treats "false" as truthy → parse explicitly.
  TELECOM_HD_CLIENT_PORTAL_ENABLED: z
    .preprocess(
      (v) => (typeof v === 'string' ? ['true', '1', 'yes'].includes(v.toLowerCase()) : Boolean(v)),
      z.boolean(),
    )
    .default(false),
});

export type AppConfig = z.infer<typeof schema>;

/** Injection token for AppConfig (use with @Inject(APP_CONFIG)). */
export const APP_CONFIG = Symbol('APP_CONFIG');

/** Default/placeholder secret that must never reach production. */
const ALARIS_DEFAULT_SECRET = 'alaris-dev-secret-change-me-0000';
/** Patterns that mark a secret as a non-production placeholder. */
const PLACEHOLDER_PATTERN = /change[-_]?me|dev[-_]?secret|placeholder|example|changeme|0{4,}/i;

/**
 * Accept a bare mailbox or a conventional `Display Name <mailbox>` sender.
 * This is intentionally a startup safety check, not a full RFC 5322 parser:
 * it rejects the shipped/documentation placeholders and local-only targets
 * while allowing ordinary production SMTP envelope addresses.
 */
function hasValidProductionMailFrom(value: string | undefined): boolean {
  const sender = value?.trim();
  if (!sender || /[\r\n]/.test(sender)) return false;

  const bracketed = sender.match(/^[^<>\r\n]*<([^<>\r\n]+)>$/);
  const address = (bracketed?.[1] ?? sender).trim();
  const match = address.match(
    /^([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i,
  );
  if (!match) return false;

  const localPart = match[1];
  const domainPart = match[2];
  if (!localPart || !domainPart) return false;
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) return false;

  const domain = domainPart.toLowerCase();
  return !(
    domain === 'localhost' ||
    domain.endsWith('.localhost') ||
    domain === 'example' ||
    domain.endsWith('.example') ||
    domain === 'example.com' ||
    domain.endsWith('.example.com')
  );
}

/**
 * In production, reject default/placeholder secrets at boot so a deployment can
 * never run with the shipped dev values. Dev/test keep the convenient defaults.
 */
export function assertProductionSecrets(cfg: AppConfig): void {
  if (cfg.NODE_ENV !== 'production') return;

  const problems: string[] = [];
  const checkSecret = (name: string, value: string | undefined) => {
    if (!value || value.trim() === '' || PLACEHOLDER_PATTERN.test(value)) {
      problems.push(`  - ${name}: must be a strong non-default value in production`);
    }
  };

  checkSecret('TELECOM_HD_JWT_ACCESS_SECRET', cfg.TELECOM_HD_JWT_ACCESS_SECRET);
  checkSecret('TELECOM_HD_JWT_REFRESH_SECRET', cfg.TELECOM_HD_JWT_REFRESH_SECRET);
  checkSecret('TELECOM_HD_ALARIS_WEBHOOK_SECRET', cfg.TELECOM_HD_ALARIS_WEBHOOK_SECRET);
  if (cfg.TELECOM_HD_ALARIS_WEBHOOK_SECRET === ALARIS_DEFAULT_SECRET) {
    problems.push('  - TELECOM_HD_ALARIS_WEBHOOK_SECRET: must not be the shipped default');
  }
  checkSecret('TELECOM_HD_INBOUND_WEBHOOK_SECRET', cfg.TELECOM_HD_INBOUND_WEBHOOK_SECRET);
  if (cfg.TELECOM_HD_JWT_ACCESS_SECRET === cfg.TELECOM_HD_JWT_REFRESH_SECRET) {
    problems.push('  - TELECOM_HD_JWT_REFRESH_SECRET: must differ from the access secret');
  }
  // Email-queue credentials must never silently fall back to plaintext in
  // production. The deployment migration converts legacy plaintext rows before
  // the new runtime starts, and this gate keeps every subsequent write encrypted.
  if (!cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY || !/^[0-9a-f]{64}$/i.test(cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY)) {
    problems.push(
      '  - TELECOM_HD_FIELD_ENCRYPTION_KEY: is required and must be 64 hex chars (256-bit) in production',
    );
  }

  // The production Compose volume is mounted only here. Allowing an arbitrary
  // path would silently split attachments/raw MIME between an ephemeral
  // container filesystem and the durable upload volume.
  if (cfg.TELECOM_HD_UPLOAD_DIR !== '/app/uploads') {
    problems.push('  - TELECOM_HD_UPLOAD_DIR: must be exactly /app/uploads in production');
  }

  if (cfg.TELECOM_HD_IMAP_BOOTSTRAP_POLICY === 'BACKFILL' && cfg.TELECOM_HD_IMAP_BACKFILL_LIMIT < 1) {
    problems.push(
      '  - TELECOM_HD_IMAP_BACKFILL_LIMIT: must be at least 1 when TELECOM_HD_IMAP_BOOTSTRAP_POLICY=BACKFILL',
    );
  }

  // S5-7: the public origin and mail host must be REAL in production — the dev localhost defaults
  // would silently break the CSRF origin allowlist, the magic-link/reset URLs, and outbound mail.
  // (These are config values, not secrets, so they use targeted checks rather than the secret
  // placeholder pattern — which would falsely reject legitimate domains containing "example".)
  const publicUrl = cfg.TELECOM_HD_PUBLIC_URL ?? '';
  if (!/^https:\/\//i.test(publicUrl) || /localhost|127\.0\.0\.1|\[::1\]/i.test(publicUrl)) {
    problems.push(
      '  - TELECOM_HD_PUBLIC_URL: must be a real https:// origin in production (not the localhost default)',
    );
  }
  const smtpHost = (cfg.TELECOM_HD_SMTP_HOST ?? '').trim();
  if (smtpHost === '' || /^(localhost|127\.0\.0\.1|\[::1\]|mailhog)$/i.test(smtpHost)) {
    problems.push('  - TELECOM_HD_SMTP_HOST: must be a real mail host in production (not localhost/MailHog)');
  }
  // The ordinary deploy preflight also checks this, but an attended
  // configuration-only outbound canary intentionally does not run deploy-prod.sh.
  // Keep the runtime boundary just as strict so nodemailer cannot silently fall
  // back to unauthenticated SMTP when a mail relay is explicitly enabled.
  if (cfg.TELECOM_HD_OUTBOUND_DELIVERY_ENABLED) {
    if (!cfg.TELECOM_HD_SMTP_USER?.trim()) {
      problems.push('  - TELECOM_HD_SMTP_USER: is required when outbound delivery is enabled in production');
    }
    checkSecret('TELECOM_HD_SMTP_PASSWORD', cfg.TELECOM_HD_SMTP_PASSWORD);
    if (!hasValidProductionMailFrom(cfg.TELECOM_HD_MAIL_FROM)) {
      problems.push(
        '  - TELECOM_HD_MAIL_FROM: must be a non-placeholder sender address when outbound delivery is enabled in production',
      );
    }
  }

  const publicChallengeEnabled =
    cfg.TELECOM_HD_CLIENT_PORTAL_ENABLED ||
    cfg.TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED ||
    cfg.TELECOM_HD_PUBLIC_UPLOAD_ENABLED ||
    cfg.TELECOM_HD_CLIENT_UPLOAD_ENABLED;
  if (publicChallengeEnabled) {
    checkSecret('TELECOM_HD_TURNSTILE_SECRET', cfg.TELECOM_HD_TURNSTILE_SECRET);
    const expectedHost = (cfg.TELECOM_HD_TURNSTILE_HOSTNAME ?? '').trim().toLowerCase();
    let publicHost = '';
    try {
      publicHost = new URL(publicUrl).hostname.toLowerCase();
    } catch {
      // The URL validation above reports the canonical error.
    }
    if (!expectedHost || expectedHost !== publicHost) {
      problems.push(
        '  - TELECOM_HD_TURNSTILE_HOSTNAME: must exactly match TELECOM_HD_PUBLIC_URL hostname when public access is enabled',
      );
    }
  }
  if (!cfg.TELECOM_HD_CLAMAV_ENABLED) {
    problems.push('  - TELECOM_HD_CLAMAV_ENABLED: must be true for production attachment safety');
  }
  if (cfg.TELECOM_HD_PUBLIC_UPLOAD_ENABLED && !cfg.TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED) {
    problems.push(
      '  - TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED: must be true when anonymous uploads are enabled',
    );
  }
  if (cfg.TELECOM_HD_CLIENT_UPLOAD_ENABLED && !cfg.TELECOM_HD_CLIENT_PORTAL_ENABLED) {
    problems.push(
      '  - TELECOM_HD_CLIENT_PORTAL_ENABLED: must be true when verified-client uploads are enabled',
    );
  }
  if (cfg.TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB < cfg.TELECOM_HD_UPLOAD_MAX_SIZE_MB) {
    problems.push(
      '  - TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB: must be greater than or equal to the per-file upload limit',
    );
  }
  if (cfg.TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB < cfg.TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB) {
    problems.push(
      '  - TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB: must be greater than or equal to the aggregate file-byte limit',
    );
  }
  if (cfg.TELECOM_HD_INBOUND_MAX_SIZE_MB < cfg.TELECOM_HD_UPLOAD_MAX_SIZE_MB) {
    problems.push(
      '  - TELECOM_HD_INBOUND_MAX_SIZE_MB: must be greater than or equal to the per-file upload limit',
    );
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start in production with insecure secrets:\n${problems.join('\n')}\n` +
        `Generate strong values: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
}

/**
 * Cross-field runtime invariants for the deliberately non-processing capture mode.
 * Keep these outside production-only validation so a development/test process cannot
 * accidentally exercise a contradictory mode either.
 */
export function assertInboundCaptureMode(cfg: AppConfig): void {
  if (!cfg.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED) return;

  const problems: string[] = [];
  if (cfg.TELECOM_HD_INBOUND_DELIVERY_ENABLED) {
    problems.push(
      '  - TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: cannot be true together with TELECOM_HD_INBOUND_DELIVERY_ENABLED=true',
    );
  }
  if (cfg.TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID !== undefined) {
    problems.push(
      '  - TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: must be blank while inbound capture-only mode is enabled',
    );
  }
  if (cfg.TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID !== undefined) {
    problems.push(
      '  - TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: must be blank while inbound capture-only mode is enabled',
    );
  }
  const captureQueueId = cfg.TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID;
  if (typeof captureQueueId !== 'number' || !Number.isSafeInteger(captureQueueId) || captureQueueId < 1) {
    problems.push(
      '  - TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: a positive, dedicated test EmailQueue id is required when capture-only mode is enabled',
    );
  }
  if (
    !Number.isInteger(cfg.TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES) ||
    cfg.TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES !== 1
  ) {
    problems.push(
      '  - TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: must be exactly 1 while inbound capture-only mode is enabled',
    );
  }
  // Capture-only is the attended path used to enter a fresh mailbox credential in a
  // local/test environment. Do not let that credential fall through the legacy
  // development plaintext behaviour of encryptField(). Production already enforces
  // the same invariant in assertProductionSecrets(); keep the test-only mode just
  // as strict at its own configuration boundary.
  if (!cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY || !/^[0-9a-f]{64}$/i.test(cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY)) {
    problems.push(
      '  - TELECOM_HD_FIELD_ENCRYPTION_KEY: must be 64 hex chars while inbound capture-only mode is enabled',
    );
  }
  if (cfg.TELECOM_HD_OUTBOUND_DELIVERY_ENABLED) {
    problems.push(
      '  - TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: must be false while inbound capture-only mode is enabled',
    );
  }
  if (cfg.TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID?.trim() || cfg.TELECOM_HD_OUTBOUND_CANARY_RECIPIENT?.trim()) {
    problems.push(
      '  - TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID and TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: must be blank while inbound capture-only mode is enabled',
    );
  }
  // A capture-only IMAP session is a canary, never a historical import. The runtime
  // additionally proves the selected folder is empty, but keep the environment policy
  // fail-closed too: a future refactor must not turn a capture restart into BACKFILL.
  if (cfg.TELECOM_HD_IMAP_BOOTSTRAP_POLICY !== 'FROM_NOW') {
    problems.push(
      '  - TELECOM_HD_IMAP_BOOTSTRAP_POLICY: must be FROM_NOW while inbound capture-only mode is enabled',
    );
  }
  if (cfg.TELECOM_HD_IMAP_BACKFILL_LIMIT !== 0) {
    problems.push('  - TELECOM_HD_IMAP_BACKFILL_LIMIT: must be 0 while inbound capture-only mode is enabled');
  }
  if (problems.length) {
    throw new Error(`Invalid inbound capture-only configuration:\n${problems.join('\n')}`);
  }
}

/**
 * A scoped SMTP canary is safe only when the selected durable command and the
 * intended sole recipient are configured together. Keep this invariant outside
 * production-only validation so dev/test cannot accidentally exercise a half
 * configured canary either.
 */
export function assertOutboundCanaryMode(cfg: AppConfig): void {
  const emailId = cfg.TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID?.trim();
  const recipient = cfg.TELECOM_HD_OUTBOUND_CANARY_RECIPIENT?.trim();
  if (Boolean(emailId) !== Boolean(recipient)) {
    throw new Error(
      'Invalid outbound canary configuration: TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID and TELECOM_HD_OUTBOUND_CANARY_RECIPIENT must be set together or both left blank',
    );
  }
  if (!emailId || !recipient) return;

  // A one-row SMTP canary is an attended, isolated test.  Do not permit it to
  // coexist with a live inbound transport or a promotion-only inbound canary:
  // otherwise incoming traffic could create unrelated ticket/outbox work while
  // an operator believes only the selected email is in scope.  Credentials may
  // be configured in advance; these selectors are the intentional test scope.
  const problems: string[] = [];
  if (cfg.TELECOM_HD_INBOUND_DELIVERY_ENABLED) {
    problems.push('  - TELECOM_HD_INBOUND_DELIVERY_ENABLED: must be false while the SMTP canary is active');
  }
  if (cfg.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED) {
    problems.push(
      '  - TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: must be false while the SMTP canary is active',
    );
  }
  if (cfg.TELECOM_HD_IMAP_ENABLED) {
    problems.push('  - TELECOM_HD_IMAP_ENABLED: must be false while the SMTP canary is active');
  }
  if (
    cfg.TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID !== undefined ||
    cfg.TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID !== undefined
  ) {
    problems.push(
      '  - TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID and TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: must be blank while the SMTP canary is active',
    );
  }
  if (problems.length) {
    throw new Error(`Invalid outbound canary configuration:\n${problems.join('\n')}`);
  }
}

/**
 * The normal inbound canary is deliberately promotion-only: pairing a queue
 * with one immutable CAPTURED delivery prevents a normal-mode restart from
 * accepting a second fresh message or draining historic rows in that queue.
 */
export function assertInboundNormalCanaryMode(cfg: AppConfig): void {
  const queueId = cfg.TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID;
  const deliveryId = cfg.TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID;
  if ((queueId === undefined) !== (deliveryId === undefined)) {
    throw new Error(
      'Invalid inbound normal canary configuration: TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID and TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID must be set together or both left blank',
    );
  }
  if (queueId !== undefined && cfg.TELECOM_HD_OUTBOUND_DELIVERY_ENABLED) {
    throw new Error(
      'Invalid inbound normal canary configuration: TELECOM_HD_OUTBOUND_DELIVERY_ENABLED must be false while the captured delivery canary is active',
    );
  }
}

export function parseConfig(environment: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    // Fail fast with a readable message at boot.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertInboundCaptureMode(parsed.data);
  assertInboundNormalCanaryMode(parsed.data);
  assertOutboundCanaryMode(parsed.data);
  assertProductionSecrets(parsed.data);
  return parsed.data;
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}
