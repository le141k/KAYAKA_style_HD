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
  TELECOM_HD_MAIL_FROM: z.string().default('23 Telecom Help Desk <support@23telecom.example>'),
  TELECOM_HD_LOG_LEVEL: z.string().default('info'),
  TELECOM_HD_ALARIS_WEBHOOK_SECRET: z.string().default('alaris-dev-secret'),
});

export type AppConfig = z.infer<typeof schema>;

/** Injection token for AppConfig (use with @Inject(APP_CONFIG)). */
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Fail fast with a readable message at boot.
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
