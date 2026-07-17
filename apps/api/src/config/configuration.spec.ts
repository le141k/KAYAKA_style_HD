import { describe, it, expect } from 'vitest';
import { assertProductionSecrets, type AppConfig } from './configuration';

const STRONG_A = 'a'.repeat(16) + 'b'.repeat(16) + '17';
const STRONG_B = 'c'.repeat(16) + 'd'.repeat(16) + '42';

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    NODE_ENV: 'production',
    TELECOM_HD_API_PORT: 4000,
    TELECOM_HD_PUBLIC_URL: 'https://help.example.com',
    DATABASE_URL: 'postgresql://u:p@db:5432/x',
    REDIS_URL: 'redis://redis:6379',
    TELECOM_HD_JWT_ACCESS_SECRET: STRONG_A,
    TELECOM_HD_JWT_REFRESH_SECRET: STRONG_B,
    TELECOM_HD_JWT_ACCESS_TTL: 900,
    TELECOM_HD_JWT_REFRESH_TTL: 2592000,
    TELECOM_HD_SMTP_HOST: 'smtp.example.com',
    TELECOM_HD_SMTP_PORT: 587,
    TELECOM_HD_SMTP_SECURE: true,
    TELECOM_HD_MAIL_FROM: 'Help <help@example.com>',
    TELECOM_HD_LOG_LEVEL: 'info',
    TELECOM_HD_ALARIS_WEBHOOK_SECRET: STRONG_A.replace('17', '99'),
    TELECOM_HD_INBOUND_WEBHOOK_SECRET: STRONG_B.replace('42', '77'),
    TELECOM_HD_UPLOAD_DIR: '/app/uploads',
    TELECOM_HD_UPLOAD_MAX_SIZE_MB: 25,
    TELECOM_HD_FIELD_ENCRYPTION_KEY: undefined,
    ...over,
  } as AppConfig;
}

describe('assertProductionSecrets', () => {
  it('passes with strong, distinct production secrets', () => {
    expect(() => assertProductionSecrets(makeConfig())).not.toThrow();
  });

  it('is a no-op outside production (dev defaults are fine)', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({
          NODE_ENV: 'development',
          TELECOM_HD_ALARIS_WEBHOOK_SECRET: 'alaris-dev-secret-change-me-0000',
          TELECOM_HD_JWT_ACCESS_SECRET: 'dev-secret-change-me-please-0000',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects placeholder JWT secrets in production', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({ TELECOM_HD_JWT_ACCESS_SECRET: 'jwt-change-me-please-aaaaaaaaaaaa' }),
      ),
    ).toThrow(/insecure secrets/i);
  });

  it('rejects the shipped Alaris default secret in production', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({ TELECOM_HD_ALARIS_WEBHOOK_SECRET: 'alaris-dev-secret-change-me-0000' }),
      ),
    ).toThrow();
  });

  it('rejects reusing the same secret for access and refresh', () => {
    expect(() => assertProductionSecrets(makeConfig({ TELECOM_HD_JWT_REFRESH_SECRET: STRONG_A }))).toThrow(
      /differ from the access secret/i,
    );
  });

  it('rejects a malformed field-encryption key', () => {
    expect(() => assertProductionSecrets(makeConfig({ TELECOM_HD_FIELD_ENCRYPTION_KEY: 'not-hex' }))).toThrow(
      /64 hex/i,
    );
  });

  // S5-7: public URL + SMTP host must be real in production.
  it('rejects the localhost public URL default in production', () => {
    expect(() =>
      assertProductionSecrets(makeConfig({ TELECOM_HD_PUBLIC_URL: 'http://localhost:3000' })),
    ).toThrow(/TELECOM_HD_PUBLIC_URL/);
  });

  it('rejects a non-https public URL in production', () => {
    expect(() =>
      assertProductionSecrets(makeConfig({ TELECOM_HD_PUBLIC_URL: 'http://help.acme.com' })),
    ).toThrow(/TELECOM_HD_PUBLIC_URL/);
  });

  it('rejects a localhost / MailHog SMTP host in production', () => {
    expect(() => assertProductionSecrets(makeConfig({ TELECOM_HD_SMTP_HOST: 'localhost' }))).toThrow(
      /TELECOM_HD_SMTP_HOST/,
    );
    expect(() => assertProductionSecrets(makeConfig({ TELECOM_HD_SMTP_HOST: 'mailhog' }))).toThrow(
      /TELECOM_HD_SMTP_HOST/,
    );
  });

  it('accepts a real https public URL + external SMTP host', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({ TELECOM_HD_PUBLIC_URL: 'https://help.acme.com', TELECOM_HD_SMTP_HOST: 'smtp.acme.com' }),
      ),
    ).not.toThrow();
  });
});
