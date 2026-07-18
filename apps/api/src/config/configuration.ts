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
  TELECOM_HD_LOG_LEVEL: z.string().default('info'),
  // Shared-secret for the Alaris webhook. Must be at least 32 chars so it carries
  // enough entropy to resist guessing; the default below is a 32-char dev value.
  // Generate a strong one: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  TELECOM_HD_ALARIS_WEBHOOK_SECRET: z.string().min(32).default('alaris-dev-secret-change-me-0000'),
  // Shared-secret for the inbound mail webhook (POST /api/inbound/pipe) used by an
  // MTA/PIPE delivery script. Same entropy requirement as the Alaris secret.
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  TELECOM_HD_INBOUND_WEBHOOK_SECRET: z.string().min(32).default('inbound-dev-secret-change-me-0000'),
  TELECOM_HD_UPLOAD_DIR: z.string().default('/app/uploads'),
  TELECOM_HD_UPLOAD_MAX_SIZE_MB: z.coerce.number().int().min(1).max(25).default(25),
  TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB: z.coerce.number().int().min(1).max(50).default(50),
  // Multipart envelope included. Keep this slightly above the aggregate file-byte
  // limit and at/below the reverse-proxy request-body limit (55 MiB in production).
  TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB: z.coerce.number().int().min(1).max(55).default(51),
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
  // Optional 256-bit AES key for field-level encryption (IMAP passwords, etc.)
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
  // Field-encryption key, if provided, must be a real 64-hex (256-bit) key.
  if (cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY)) {
    problems.push('  - TELECOM_HD_FIELD_ENCRYPTION_KEY: must be 64 hex chars (256-bit) when set');
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

export function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast with a readable message at boot.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  assertProductionSecrets(parsed.data);
  return parsed.data;
}
