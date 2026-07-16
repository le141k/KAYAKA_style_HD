/**
 * Integration test (A2 + A4): inbound mail → CLIENT ticket → spawn linked SUPPLIER
 * ticket, plus dedup + threading, exercised end-to-end against a real Postgres
 * (Testcontainers) and the booted NestJS app via the inbound webhook.
 *
 * The webhook (POST /api/inbound/pipe) shares InboundMailService.ingestRawMessage
 * with the IMAP poller, so proving the pipeline here proves both transports.
 *
 * NOT run during `npm test` (unit only). Run via: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import type { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

let PostgreSqlContainerCtor: typeof PostgreSqlContainer;
let container: StartedPostgreSqlContainer;
let app: INestApplication;
let request: ReturnType<typeof supertest>;
let adminToken: string;

const INBOUND_SECRET = 'inbound-dev-secret-change-me-0000';
const CLIENT_EMAIL = 'carrier-noc@acme-telecom.example';
const FIRST_MESSAGE_ID = '<inbound-int-1@acme-telecom.example>';

/** A real multipart/alternative MIME message (text + html). */
function buildMime(messageId: string, inReplyTo?: string): string {
  return [
    `From: NOC Team <${CLIENT_EMAIL}>`,
    'To: noc@23telecom.co.uk',
    'Subject: SMS not delivered to ES route',
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="bound42"',
    '',
    '--bound42',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Our ES route is failing since 09:00 UTC. Please investigate.',
    '',
    '--bound42',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Our ES route is failing since 09:00 UTC. Please investigate.</p>',
    '',
    '--bound42--',
    '',
  ].join('\r\n');
}

async function listTicketsByRequester(email: string): Promise<Array<{ id: number; requesterEmail: string }>> {
  const res = await request
    .get('/api/tickets?page=1&limit=100')
    .set('Authorization', `Bearer ${adminToken}`)
    .expect(200);
  const body = res.body as { data: Array<{ id: number; requesterEmail: string }> };
  return body.data.filter((t) => t.requesterEmail === email);
}

beforeAll(async () => {
  const tc = await import('@testcontainers/postgresql');
  PostgreSqlContainerCtor = tc.PostgreSqlContainer;
  container = await new PostgreSqlContainerCtor('postgres:16-alpine')
    .withDatabase('hd_test')
    .withUsername('hd')
    .withPassword('hd_test_pass')
    .start();

  const databaseUrl = container.getConnectionUri();
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['TELECOM_HD_JWT_ACCESS_SECRET'] = 'int-test-access-secret-32chars!!';
  process.env['TELECOM_HD_JWT_REFRESH_SECRET'] = 'int-test-refresh-secret-32chars!!';
  process.env['TELECOM_HD_INBOUND_WEBHOOK_SECRET'] = INBOUND_SECRET;

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

  const { AppModule } = await import('../../app.module');
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  request = supertest(app.getHttpServer());

  const loginRes = await request
    .post('/api/auth/login')
    .send({ email: 'admin@23telecom.example', password: 'demo1234' })
    .expect(200);
  adminToken = (loginRes.body as { accessToken: string }).accessToken;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await container?.stop();
});

describe('Inbound mail integration (A2 + A4)', () => {
  let clientTicketId: number;

  it('rejects the webhook without the shared secret', async () => {
    await request
      .post('/api/inbound/pipe')
      .send({ raw: buildMime(FIRST_MESSAGE_ID) })
      .expect(403);
  });

  it('A2 — a delivered email creates a CLIENT ticket with the parsed body', async () => {
    await request
      .post('/api/inbound/pipe')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({ raw: buildMime(FIRST_MESSAGE_ID) })
      .expect(202);

    const mine = await listTicketsByRequester(CLIENT_EMAIL);
    expect(mine).toHaveLength(1);
    clientTicketId = mine[0]!.id;

    const detail = await request
      .get(`/api/tickets/${clientTicketId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = detail.body as {
      subject: string;
      creationMode: string;
      posts: Array<{ contents: string }>;
    };
    expect(body.subject).toContain('ES route');
    expect(body.creationMode).toBe('EMAIL');
    expect(body.posts[0]!.contents).toContain('ES route is failing');
  });

  it('A3 — re-delivering the same Message-ID creates no duplicate', async () => {
    await request
      .post('/api/inbound/pipe')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({ raw: buildMime(FIRST_MESSAGE_ID) })
      .expect(202);
    const mine = await listTicketsByRequester(CLIENT_EMAIL);
    expect(mine).toHaveLength(1); // still one
  });

  it('A3 — a reply (In-Reply-To) threads onto the same ticket, no new ticket', async () => {
    await request
      .post('/api/inbound/pipe')
      .set('x-inbound-secret', INBOUND_SECRET)
      .send({ raw: buildMime('<inbound-int-2@acme-telecom.example>', FIRST_MESSAGE_ID) })
      .expect(202);

    const mine = await listTicketsByRequester(CLIENT_EMAIL);
    expect(mine).toHaveLength(1); // threaded, not a new ticket

    const detail = await request
      .get(`/api/tickets/${clientTicketId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = detail.body as { posts: unknown[] };
    expect(body.posts.length).toBeGreaterThanOrEqual(2); // original + threaded reply
  });

  it('A4 — spawning a supplier creates a linked SUPPLIER ticket (two-way TicketLink)', async () => {
    const spawn = await request
      .post(`/api/tickets/${clientTicketId}/spawn-supplier`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        supplierEmail: 'noc@sinch.example',
        supplierName: 'Sinch',
        contents: 'Please fix the ES route',
      })
      .expect(201);
    const spawnBody = spawn.body as { ticket: { id: number }; linkId: number; clientTicketId: number };
    expect(spawnBody.clientTicketId).toBe(clientTicketId);
    const supplierTicketId = spawnBody.ticket.id;
    expect(supplierTicketId).not.toBe(clientTicketId);

    // Client side shows a supplier link to the new ticket.
    const clientLinks = await request
      .get(`/api/tickets/${clientTicketId}/links`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const cl = clientLinks.body as Array<{ linkType: string; ticket: { id: number } }>;
    expect(cl.some((l) => l.ticket.id === supplierTicketId && l.linkType === 'supplier')).toBe(true);

    // Supplier ticket exists and is a distinct ticket from the client one.
    const supplierDetail = await request
      .get(`/api/tickets/${supplierTicketId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const sd = supplierDetail.body as { requesterEmail: string };
    expect(sd.requesterEmail).toBe('noc@sinch.example');
  });
});
