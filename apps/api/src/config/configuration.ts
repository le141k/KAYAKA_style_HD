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
  TELECOM_HD_UPLOAD_DIR: z.string().default('/app/uploads'),
  TELECOM_HD_UPLOAD_MAX_SIZE_MB: z.coerce.number().default(25),
  // Optional 256-bit AES key for field-level encryption (IMAP passwords, etc.)
  // Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  TELECOM_HD_FIELD_ENCRYPTION_KEY: z.string().optional(),
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
  if (cfg.TELECOM_HD_JWT_ACCESS_SECRET === cfg.TELECOM_HD_JWT_REFRESH_SECRET) {
    problems.push('  - TELECOM_HD_JWT_REFRESH_SECRET: must differ from the access secret');
  }
  // Field-encryption key, if provided, must be a real 64-hex (256-bit) key.
  if (cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY && !/^[0-9a-f]{64}$/i.test(cfg.TELECOM_HD_FIELD_ENCRYPTION_KEY)) {
    problems.push('  - TELECOM_HD_FIELD_ENCRYPTION_KEY: must be 64 hex chars (256-bit) when set');
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
