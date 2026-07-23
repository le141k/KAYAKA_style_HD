import { describe, it, expect } from 'vitest';
import {
  assertInboundCaptureMode,
  assertInboundNormalCanaryMode,
  assertOutboundCanaryMode,
  parseConfig,
  assertProductionSecrets,
  type AppConfig,
} from './configuration';

const STRONG_A = 'a'.repeat(16) + 'b'.repeat(16) + '17';
const STRONG_B = 'c'.repeat(16) + 'd'.repeat(16) + '42';
const FIELD_ENCRYPTION_KEY = 'e'.repeat(64);

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
    TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: false,
    TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: undefined,
    TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: undefined,
    TELECOM_HD_MAIL_FROM: 'Help <help@acme.com>',
    TELECOM_HD_LOG_LEVEL: 'info',
    TELECOM_HD_ALARIS_WEBHOOK_SECRET: STRONG_A.replace('17', '99'),
    TELECOM_HD_INBOUND_WEBHOOK_SECRET: STRONG_B.replace('42', '77'),
    TELECOM_HD_UPLOAD_DIR: '/app/uploads',
    TELECOM_HD_UPLOAD_MAX_SIZE_MB: 25,
    TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB: 50,
    TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB: 51,
    TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
    TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS: 24,
    TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT: 2000,
    TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB: 2048,
    TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB: 5120,
    TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS: 1000,
    TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS: 120,
    TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED: false,
    TELECOM_HD_PUBLIC_UPLOAD_ENABLED: false,
    TELECOM_HD_CLIENT_UPLOAD_ENABLED: false,
    TELECOM_HD_CLAMAV_ENABLED: true,
    TELECOM_HD_CLAMAV_HOST: 'clamav',
    TELECOM_HD_CLAMAV_PORT: 3310,
    TELECOM_HD_CLAMAV_TIMEOUT_MS: 15000,
    TELECOM_HD_CLIENT_PORTAL_ENABLED: false,
    TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
    TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: undefined,
    TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: undefined,
    TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: false,
    TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: undefined,
    TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
    TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'FROM_NOW',
    TELECOM_HD_IMAP_BACKFILL_LIMIT: 0,
    TELECOM_HD_FIELD_ENCRYPTION_KEY: FIELD_ENCRYPTION_KEY,
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

  it('rejects a missing field-encryption key in production', () => {
    expect(() => assertProductionSecrets(makeConfig({ TELECOM_HD_FIELD_ENCRYPTION_KEY: undefined }))).toThrow(
      /FIELD_ENCRYPTION_KEY.*required/i,
    );
  });

  it('requires the durable production upload mount path exactly', () => {
    expect(() => assertProductionSecrets(makeConfig({ TELECOM_HD_UPLOAD_DIR: '/tmp/uploads' }))).toThrow(
      /TELECOM_HD_UPLOAD_DIR.*\/app\/uploads/i,
    );
  });

  it('rejects a zero global backfill when BACKFILL is selected', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({ TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'BACKFILL', TELECOM_HD_IMAP_BACKFILL_LIMIT: 0 }),
      ),
    ).toThrow(/IMAP_BACKFILL_LIMIT.*at least 1/i);
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

  it('requires authenticated SMTP credentials for a production outbound canary', () => {
    expect(() => assertProductionSecrets(makeConfig({ TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: true }))).toThrow(
      /SMTP_USER.*required.*outbound delivery/i,
    );
    expect(() =>
      assertProductionSecrets(
        makeConfig({
          TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_SMTP_USER: 'noc@23telecom.co.uk',
          TELECOM_HD_SMTP_PASSWORD: 'app-password-value',
        }),
      ),
    ).not.toThrow();
  });

  it('requires a real, syntactically valid sender when production outbound delivery is enabled', () => {
    const enabledOutbound = {
      TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: true,
      TELECOM_HD_SMTP_USER: 'noc@acme.com',
      TELECOM_HD_SMTP_PASSWORD: 'app-password-value',
    } as const;

    expect(() =>
      assertProductionSecrets(
        makeConfig({ ...enabledOutbound, TELECOM_HD_MAIL_FROM: 'Help <help@example.com>' }),
      ),
    ).toThrow(/MAIL_FROM.*non-placeholder sender/i);
    expect(() =>
      assertProductionSecrets(makeConfig({ ...enabledOutbound, TELECOM_HD_MAIL_FROM: 'help@example' })),
    ).toThrow(/MAIL_FROM.*non-placeholder sender/i);
    expect(() =>
      assertProductionSecrets(makeConfig({ ...enabledOutbound, TELECOM_HD_MAIL_FROM: 'help@localhost' })),
    ).toThrow(/MAIL_FROM.*non-placeholder sender/i);
    expect(() =>
      assertProductionSecrets(makeConfig({ ...enabledOutbound, TELECOM_HD_MAIL_FROM: '' })),
    ).toThrow(/MAIL_FROM.*non-placeholder sender/i);
    expect(() =>
      assertProductionSecrets(makeConfig({ ...enabledOutbound, TELECOM_HD_MAIL_FROM: 'not an email' })),
    ).toThrow(/MAIL_FROM.*non-placeholder sender/i);
    expect(() =>
      assertProductionSecrets(
        makeConfig({ ...enabledOutbound, TELECOM_HD_MAIL_FROM: 'Help Desk <help@acme.com>' }),
      ),
    ).not.toThrow();
  });

  it('rejects placeholder SMTP passwords when production outbound delivery is enabled', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({
          TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_SMTP_USER: 'noc@acme.com',
          TELECOM_HD_SMTP_PASSWORD: 'CHANGE_ME_smtp_password',
        }),
      ),
    ).toThrow(/SMTP_PASSWORD.*strong non-default/i);
  });

  it('rejects verified-client uploads while the client portal is closed', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({
          TELECOM_HD_CLIENT_PORTAL_ENABLED: false,
          TELECOM_HD_CLIENT_UPLOAD_ENABLED: true,
        }),
      ),
    ).toThrow(/CLIENT_PORTAL_ENABLED/);
  });

  it('allows the client portal read surface while its upload switch stays closed', () => {
    expect(() =>
      assertProductionSecrets(
        makeConfig({
          TELECOM_HD_PUBLIC_URL: 'https://help.acme.com',
          TELECOM_HD_SMTP_HOST: 'smtp.acme.com',
          TELECOM_HD_CLIENT_PORTAL_ENABLED: true,
          TELECOM_HD_CLIENT_UPLOAD_ENABLED: false,
          TELECOM_HD_TURNSTILE_SECRET: STRONG_A,
          TELECOM_HD_TURNSTILE_HOSTNAME: 'help.acme.com',
        }),
      ),
    ).not.toThrow();
  });
});

describe('assertInboundCaptureMode', () => {
  it('accepts an explicitly scoped capture-only configuration with physical outbound disabled', () => {
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
        }),
      ),
    ).not.toThrow();
  });

  it('rejects capture-only combined with normal processing or physical outbound delivery', () => {
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
        }),
      ),
    ).toThrow(/cannot be true together/i);
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: true,
        }),
      ),
    ).toThrow(/OUTBOUND_DELIVERY_ENABLED.*must be false/i);
  });

  it('rejects every normal-delivery and SMTP canary selector while capture-only is active', () => {
    const capture = {
      TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
      TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
    } as const;

    expect(() =>
      assertInboundCaptureMode(makeConfig({ ...capture, TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 99 })),
    ).toThrow(/INBOUND_NORMAL_CANARY_QUEUE_ID.*blank/i);
    expect(() =>
      assertInboundCaptureMode(makeConfig({ ...capture, TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99 })),
    ).toThrow(/INBOUND_NORMAL_CANARY_DELIVERY_ID.*blank/i);
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          ...capture,
          TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: 'cmoutbox00000000000000001',
          TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: 'noc@acme.com',
        }),
      ),
    ).toThrow(/OUTBOUND_CANARY.*blank/i);
  });

  it('rejects capture-only without an explicit queue id', () => {
    expect(() =>
      assertInboundCaptureMode(makeConfig({ TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true })),
    ).toThrow(/CAPTURE_QUEUE_ID/i);
  });

  it('rejects an unsafe hand-built capture queue id instead of silently closing the runtime gate', () => {
    for (const queueId of [-1, 1.5, Number.NaN]) {
      expect(() =>
        assertInboundCaptureMode(
          makeConfig({
            TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
            TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: queueId,
          }),
        ),
      ).toThrow(/CAPTURE_QUEUE_ID/i);
    }
  });

  it('accepts exactly one capture message and rejects every wider or malformed capacity', () => {
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 0,
        }),
      ),
    ).toThrow(/CAPTURE_MAX_MESSAGES/i);
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 2,
        }),
      ),
    ).toThrow(/CAPTURE_MAX_MESSAGES/i);
  });

  it('requires a valid field-encryption key in capture-only mode outside production too', () => {
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          NODE_ENV: 'development',
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: undefined,
        }),
      ),
    ).toThrow(/FIELD_ENCRYPTION_KEY/i);
  });

  it('refuses a historical IMAP bootstrap policy in capture-only mode', () => {
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'BACKFILL',
          TELECOM_HD_IMAP_BACKFILL_LIMIT: 1,
        }),
      ),
    ).toThrow(/BOOTSTRAP_POLICY.*FROM_NOW/i);
    expect(() =>
      assertInboundCaptureMode(
        makeConfig({
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 42,
          TELECOM_HD_IMAP_BACKFILL_LIMIT: 1,
        }),
      ),
    ).toThrow(/BACKFILL_LIMIT.*0/i);
  });
});

describe('assertOutboundCanaryMode', () => {
  it('requires the durable command id and recipient to be configured together', () => {
    const emailId = 'cmoutbox00000000000000001';
    const recipient = 'noc@acme.com';

    expect(() =>
      assertOutboundCanaryMode(makeConfig({ TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: emailId })),
    ).toThrow(/CANARY_EMAIL_ID.*CANARY_RECIPIENT.*together/i);
    expect(() =>
      assertOutboundCanaryMode(makeConfig({ TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: recipient })),
    ).toThrow(/CANARY_EMAIL_ID.*CANARY_RECIPIENT.*together/i);
    expect(() =>
      assertOutboundCanaryMode(
        makeConfig({
          TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: emailId,
          TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: recipient,
        }),
      ),
    ).not.toThrow();
  });

  it('requires every inbound transport and inbound canary selector to be closed', () => {
    const canary = {
      TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: 'cmoutbox00000000000000001',
      TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: 'noc@acme.com',
    };
    expect(() =>
      assertOutboundCanaryMode(
        makeConfig({
          ...canary,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_IMAP_ENABLED: true,
          TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 42,
          TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99,
        }),
      ),
    ).toThrow(/INBOUND_DELIVERY_ENABLED.*IMAP_ENABLED.*NORMAL_CANARY_QUEUE_ID/is);
  });
});

describe('assertInboundNormalCanaryMode', () => {
  it('requires the captured queue id and delivery id to be configured together', () => {
    expect(() =>
      assertInboundNormalCanaryMode(makeConfig({ TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 42 })),
    ).toThrow(/NORMAL_CANARY_QUEUE_ID.*NORMAL_CANARY_DELIVERY_ID.*together/i);
    expect(() =>
      assertInboundNormalCanaryMode(makeConfig({ TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99 })),
    ).toThrow(/NORMAL_CANARY_QUEUE_ID.*NORMAL_CANARY_DELIVERY_ID.*together/i);
    expect(() =>
      assertInboundNormalCanaryMode(
        makeConfig({
          TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 42,
          TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99,
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertInboundNormalCanaryMode(
        makeConfig({
          TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 42,
          TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99,
          TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: true,
        }),
      ),
    ).toThrow(/OUTBOUND_DELIVERY_ENABLED.*false/i);
  });
});

describe('parseConfig canary fences', () => {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://u:p@db:5432/x',
    TELECOM_HD_JWT_ACCESS_SECRET: STRONG_A,
    TELECOM_HD_JWT_REFRESH_SECRET: STRONG_B,
  };

  it('parses paired positive safe inbound ids and normalizes blank canary fields to undefined', () => {
    expect(
      parseConfig({
        ...environment,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: '42',
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: '99',
        TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: '',
        TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: ' ',
      }),
    ).toMatchObject({
      TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 42,
      TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99,
      TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: undefined,
      TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: undefined,
    });
  });

  it('rejects unsafe/half-configured inbound ids and malformed or half-configured SMTP canary fences', () => {
    expect(() =>
      parseConfig({ ...environment, TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: '9007199254740992' }),
    ).toThrow(/INBOUND_NORMAL_CANARY_QUEUE_ID/i);
    expect(() => parseConfig({ ...environment, TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: '42' })).toThrow(
      /NORMAL_CANARY_QUEUE_ID.*NORMAL_CANARY_DELIVERY_ID.*together/i,
    );
    expect(() =>
      parseConfig({
        ...environment,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: '42',
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: '99',
        TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: 'true',
      }),
    ).toThrow(/OUTBOUND_DELIVERY_ENABLED.*false/i);
    expect(() =>
      parseConfig({
        ...environment,
        TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: 'not-a-cuid',
        TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: 'noc@acme.com',
      }),
    ).toThrow(/OUTBOUND_CANARY_EMAIL_ID/i);
    expect(() =>
      parseConfig({
        ...environment,
        TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: 'cmoutbox00000000000000001',
        TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: 'not an email',
      }),
    ).toThrow(/OUTBOUND_CANARY_RECIPIENT/i);
    expect(() =>
      parseConfig({ ...environment, TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: 'cmoutbox00000000000000001' }),
    ).toThrow(/CANARY_EMAIL_ID.*CANARY_RECIPIENT.*together/i);
  });
});
