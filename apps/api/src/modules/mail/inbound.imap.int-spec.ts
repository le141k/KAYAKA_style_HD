/**
 * Live IMAP integration gate.
 *
 * This deliberately uses GreenMail over a real socket plus a disposable PostgreSQL
 * instance.  The unit suite's fake ImapFlow remains valuable for races that a mail
 * server cannot deterministically trigger, while this gate proves the production
 * `connect → synchronous FROM_NOW baseline → pollNow` path does not silently import
 * history or miss the first later UID.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import nodemailer from 'nodemailer';
import type { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedTestContainer } from 'testcontainers';
import { encryptField } from '../../common/field-encrypt.util';
import {
  prepareIsolatedIntegrationEnvironment,
  redisConnectionUri,
  startDisposableRedis,
  type IsolatedIntegrationEnvironment,
} from '../../test/integration-runtime';
import { InboundMailService } from './inbound.service';

let PostgreSqlContainerCtor: typeof PostgreSqlContainer;
let postgres: StartedPostgreSqlContainer;
let greenmail: StartedTestContainer;
let redis: StartedTestContainer;
let prisma: PrismaClient;
let app: INestApplication;
let inbound: InboundMailService;
let integrationEnvironment: IsolatedIntegrationEnvironment;
let queueId: number;
let smtpPort: number;
let imapPort: number;

const FIELD_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const GREENMAIL_USER = 'gate';
const GREENMAIL_PASSWORD = 'gatepass';
const QUEUE_ADDRESS = 'gate@localhost';
const HISTORY_MESSAGE_ID = '<live-imap-history@synthetic.invalid>';
const FRESH_MESSAGE_ID = '<live-imap-fresh@synthetic.invalid>';

async function deliverSyntheticMail(subject: string, messageId: string, sender: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: greenmail.getHost(),
    port: smtpPort,
    secure: false,
    auth: { user: GREENMAIL_USER, pass: GREENMAIL_PASSWORD },
  });
  await transport.sendMail({
    from: sender,
    to: QUEUE_ADDRESS,
    subject,
    text: `Local-only synthetic IMAP gate message: ${subject}`,
    messageId,
  });
  transport.close();
}

beforeAll(async () => {
  const tc = await import('@testcontainers/postgresql');
  const genericTc = await import('testcontainers');
  PostgreSqlContainerCtor = tc.PostgreSqlContainer;

  postgres = await new PostgreSqlContainerCtor('postgres:16-alpine')
    .withDatabase('hd_live_imap_test')
    .withUsername('hd')
    .withPassword('hd_live_imap_pass')
    .start();
  redis = await startDisposableRedis();
  greenmail = await new genericTc.GenericContainer('greenmail/standalone:2.1.11')
    .withEnvironment({
      // Bind beyond the container loopback so Testcontainers' published host ports
      // represent the same real TCP path used by ImapFlow in the application.
      GREENMAIL_OPTS:
        '-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=gate:gatepass@localhost',
    })
    .withExposedPorts(3025, 3143)
    .start();

  const databaseUrl = postgres.getConnectionUri();
  const redisUrl = redisConnectionUri(redis);
  smtpPort = greenmail.getMappedPort(3025);
  imapPort = greenmail.getMappedPort(3143);
  integrationEnvironment = prepareIsolatedIntegrationEnvironment({
    databaseUrl,
    redisUrl,
    inboundDeliveryEnabled: true,
    imapEnabled: true,
  });

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  execSync('npx tsx src/seed/seed.ts', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const support = await prisma.department.findFirst({ where: { title: 'Support' }, select: { id: true } });
  if (!support) throw new Error('Integration seed did not create the Support department');

  // This one must exist before Nest runs InboundMailService.onModuleInit(): it supplies
  // the historical UID that the synchronous FROM_NOW bootstrap must skip.
  await deliverSyntheticMail(
    'Historical message — must not import',
    HISTORY_MESSAGE_ID,
    'history@synthetic.invalid',
  );
  const queue = await prisma.emailQueue.create({
    data: {
      type: 'IMAP',
      emailAddress: QUEUE_ADDRESS,
      host: greenmail.getHost(),
      port: imapPort,
      username: GREENMAIL_USER,
      passwordEnc: encryptField(GREENMAIL_PASSWORD, FIELD_KEY),
      // GreenMail's plaintext IMAP endpoint is deliberately test-only. Production
      // capture mode separately enforces implicit TLS and has its own attended gate.
      useTls: false,
      mailbox: 'INBOX',
      departmentId: support.id,
      isEnabled: true,
    },
    select: { id: true },
  });
  queueId = queue.id;

  const { AppModule } = await import('../../app.module');
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  inbound = moduleRef.get(InboundMailService);
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    await prisma?.$disconnect();
  } finally {
    await Promise.allSettled([greenmail?.stop(), redis?.stop(), postgres?.stop()]);
    integrationEnvironment?.restore();
  }
});

describe('InboundMailService live IMAP / FROM_NOW gate', () => {
  it('skips the pre-bootstrap UID and accepts exactly the next live UID', async () => {
    const baseline = await prisma.emailQueue.findUniqueOrThrow({
      where: { id: queueId },
      select: { uidValidity: true, lastSeenUid: true, syncState: true },
    });
    expect(baseline.syncState).toBe('OK');
    expect(baseline.uidValidity).not.toBeNull();
    expect(baseline.lastSeenUid).toBe(BigInt(1));
    expect(await prisma.inboundDelivery.count({ where: { queueId } })).toBe(0);

    await deliverSyntheticMail('Fresh message — must import', FRESH_MESSAGE_ID, 'fresh@synthetic.invalid');
    await inbound.pollNow();

    const deliveries = await prisma.inboundDelivery.findMany({
      where: { queueId },
      orderBy: { id: 'asc' },
      select: {
        messageId: true,
        messageIdHash: true,
        observedMessageId: true,
        state: true,
        uid: true,
        subject: true,
      },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      // `InboundDelivery.messageId` is the retained legacy compatibility claim.
      // New runtime stores the logical identity in InboundMessageClaim instead.
      messageId: null,
      observedMessageId: FRESH_MESSAGE_ID,
      state: 'PROCESSED',
      uid: BigInt(2),
      subject: 'Fresh message — must import',
    });
    expect(deliveries[0]?.messageIdHash).toMatch(/^[a-f0-9]{64}$/);
    const claim = await prisma.inboundMessageClaim.findUniqueOrThrow({
      where: { messageIdHash: deliveries[0]!.messageIdHash! },
      select: { normalizedMessageId: true },
    });
    expect(claim.normalizedMessageId).toBe(FRESH_MESSAGE_ID);

    const skippedHistory = await prisma.ticketPost.count({ where: { inboundMessageId: HISTORY_MESSAGE_ID } });
    const processedFresh = await prisma.ticketPost.count({ where: { inboundMessageId: FRESH_MESSAGE_ID } });
    expect(skippedHistory).toBe(0);
    expect(processedFresh).toBe(1);

    const cursor = await prisma.emailQueue.findUniqueOrThrow({
      where: { id: queueId },
      select: { lastSeenUid: true },
    });
    expect(cursor.lastSeenUid).toBe(BigInt(2));
  });
});
