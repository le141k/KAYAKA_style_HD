import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StartedTestContainer } from 'testcontainers';

const FIELD_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TEST_WEBHOOK_SECRET = 'inbound-integration-test-secret-000000';

export interface IsolatedIntegrationEnvironment {
  uploadsDir: string;
  restore(): void;
}

export interface IsolatedIntegrationEnvironmentOptions {
  databaseUrl: string;
  redisUrl: string;
  inboundDeliveryEnabled?: boolean;
  imapEnabled?: boolean;
  inboundWebhookSecret?: string;
}

/** Start a private Redis server for one HTTP integration fixture. */
export async function startDisposableRedis(): Promise<StartedTestContainer> {
  const { GenericContainer } = await import('testcontainers');
  return new GenericContainer('redis:7.4-alpine').withExposedPorts(6379).start();
}

export function redisConnectionUri(container: StartedTestContainer): string {
  return `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
}

/**
 * Pin all stateful/external integration dependencies before dynamically importing
 * AppModule. This avoids using a developer's Redis, SMTP, Turnstile, IMAP/capture
 * selectors, or any existing canary configuration. The caller must invoke restore
 * after it closes its Nest application and containers.
 */
export function prepareIsolatedIntegrationEnvironment(
  options: IsolatedIntegrationEnvironmentOptions,
): IsolatedIntegrationEnvironment {
  const uploadsDir = mkdtempSync(join(tmpdir(), 'telecom-hd-integration-'));
  const values: Record<string, string> = {
    DATABASE_URL: options.databaseUrl,
    REDIS_URL: options.redisUrl,
    NODE_ENV: 'test',
    TELECOM_HD_PUBLIC_URL: 'http://localhost:3000',
    TELECOM_HD_JWT_ACCESS_SECRET: 'integration-test-access-secret-32chars!',
    TELECOM_HD_JWT_REFRESH_SECRET: 'integration-test-refresh-secret-32chars!',
    TELECOM_HD_FIELD_ENCRYPTION_KEY: FIELD_KEY,
    TELECOM_HD_UPLOAD_DIR: uploadsDir,
    TELECOM_HD_SMTP_HOST: '127.0.0.1',
    TELECOM_HD_SMTP_PORT: '1',
    TELECOM_HD_SMTP_SECURE: 'false',
    TELECOM_HD_SMTP_USER: '',
    TELECOM_HD_SMTP_PASSWORD: '',
    TELECOM_HD_MAIL_FROM: 'Help Desk Test <helpdesk@synthetic.invalid>',
    TELECOM_HD_TURNSTILE_SECRET: '',
    TELECOM_HD_TURNSTILE_HOSTNAME: '',
    TELECOM_HD_CLAMAV_ENABLED: 'false',
    TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: 'false',
    TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID: '',
    TELECOM_HD_OUTBOUND_CANARY_RECIPIENT: '',
    TELECOM_HD_INBOUND_DELIVERY_ENABLED: String(options.inboundDeliveryEnabled === true),
    TELECOM_HD_IMAP_ENABLED: String(options.imapEnabled === true),
    TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: 'false',
    TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: '',
    TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: '1',
    TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: '',
    TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: '',
    TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'FROM_NOW',
    TELECOM_HD_IMAP_BACKFILL_LIMIT: '0',
    TELECOM_HD_INBOUND_WEBHOOK_SECRET: options.inboundWebhookSecret ?? TEST_WEBHOOK_SECRET,
    TELECOM_HD_ALARIS_WEBHOOK_SECRET: 'alaris-integration-test-secret-0000000',
    TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED: 'false',
    TELECOM_HD_PUBLIC_UPLOAD_ENABLED: 'false',
    TELECOM_HD_CLIENT_UPLOAD_ENABLED: 'false',
    TELECOM_HD_CLIENT_PORTAL_ENABLED: 'false',
    TELECOM_HD_PUBLIC_SUBMIT_LIMIT: '1000',
    TELECOM_HD_PUBLIC_REPLY_LIMIT: '1000',
    TELECOM_HD_PUBLIC_READ_LIMIT: '1000',
    TELECOM_HD_PUBLIC_UPLOAD_LIMIT: '1000',
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  let restored = false;
  return {
    uploadsDir,
    restore() {
      if (restored) return;
      restored = true;
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(uploadsDir, { recursive: true, force: true });
    },
  };
}
