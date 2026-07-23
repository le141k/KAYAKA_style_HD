/**
 * Integration test: Ticket create → reply → list flow.
 *
 * Uses @testcontainers/postgresql to spin up a real Postgres instance,
 * runs prisma migrate deploy against it, then exercises the NestJS app
 * via supertest HTTP.
 *
 * NOTE: This suite is intentionally NOT run during `npm test` (unit only).
 * Run via: npm run test:integration
 *
 * Requirements (installed, not yet available on this machine):
 *   - @testcontainers/postgresql
 *   - @nestjs/testing
 *   - supertest
 *   - prisma CLI (execSync)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import type { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { StartedTestContainer } from 'testcontainers';
import {
  prepareIsolatedIntegrationEnvironment,
  redisConnectionUri,
  startDisposableRedis,
  type IsolatedIntegrationEnvironment,
} from '../../test/integration-runtime';

// Lazy import to avoid crashing when testcontainers is not installed
let PostgreSqlContainerCtor: typeof PostgreSqlContainer;

let container: StartedPostgreSqlContainer;
let redis: StartedTestContainer;
let app: INestApplication;
let staffRequest: ReturnType<typeof supertest.agent>;
let publicRequest: ReturnType<typeof supertest>;
let csrfToken: string;
let integrationEnvironment: IsolatedIntegrationEnvironment;

function csrfCookieFrom(response: supertest.Response): string {
  const raw = response.headers['set-cookie'];
  const setCookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const csrfCookie = setCookies.find((value) => /^(?:th_csrf|__Host-th_csrf)=/.test(value));
  const value = csrfCookie?.split(';', 1)[0]?.split('=', 2)[1];
  if (!value) throw new Error('Login did not issue a CSRF cookie');
  return decodeURIComponent(value);
}

beforeAll(async () => {
  // ── 1. Start a Postgres container ──────────────────────────────────────────
  const tc = await import('@testcontainers/postgresql');
  PostgreSqlContainerCtor = tc.PostgreSqlContainer;

  container = await new PostgreSqlContainerCtor('postgres:16-alpine')
    .withDatabase('hd_test')
    .withUsername('hd')
    .withPassword('hd_test_pass')
    .start();

  const databaseUrl = container.getConnectionUri();
  redis = await startDisposableRedis();
  integrationEnvironment = prepareIsolatedIntegrationEnvironment({
    databaseUrl,
    redisUrl: redisConnectionUri(redis),
  });

  // ── 2. Run migrations ───────────────────────────────────────────────────────
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  // ── 3. Run seed ─────────────────────────────────────────────────────────────
  execSync('npx tsx src/seed/seed.ts', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  // ── 4. Bootstrap NestJS app ─────────────────────────────────────────────────
  const { AppModule } = await import('../../app.module');
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();

  staffRequest = supertest.agent(app.getHttpServer());
  publicRequest = supertest(app.getHttpServer());

  // ── 5. Log in as admin with the browser cookie contract ─────────────────────
  const loginRes = await staffRequest
    .post('/api/auth/login')
    .set('Origin', 'http://localhost:3000')
    .send({ email: 'admin@23telecom.example', password: 'demo1234' })
    .expect(200);

  expect(loginRes.body).toHaveProperty('staff');
  expect(loginRes.body).not.toHaveProperty('accessToken');
  expect(loginRes.body).not.toHaveProperty('refreshToken');
  csrfToken = csrfCookieFrom(loginRes);
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    await Promise.allSettled([redis?.stop(), container?.stop()]);
    integrationEnvironment?.restore();
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Tickets integration', () => {
  let ticketId: number;
  let ticketTotalRepliesAfterCreate: number;

  /**
   * Create a ticket via the public portal endpoint (POST /api/tickets/public).
   * This route is @Public() and uses a parameter-scoped pipe, so it works
   * without the @UsePipes + @CurrentStaff() conflict that affects the staff
   * create route. Returns 201 with the full ticket object including mask.
   */
  it('POST /api/tickets/public — creates a ticket (public portal)', async () => {
    const res = await publicRequest
      .post('/api/tickets/public')
      .send({
        subject: 'Integration test ticket',
        challengeToken: 'integration-test-bypass',
        contents: 'This is the initial post body.',
        requesterEmail: 'inttest@example.com',
        requesterName: 'Integration Tester',
        customFields: {},
      })
      .expect(201);

    // D7: the public projection returns only id/mask/subject/statusId/createdAt
    // (no internal fields). totalReplies is verified via the authenticated GET below.
    const body = res.body as { id: number; mask: string; subject: string };
    expect(body.mask).toMatch(/^TT-\d{6,}$/);
    expect(body.subject).toBe('Integration test ticket');
    ticketId = body.id;
  });

  it('GET /api/tickets/:id — retrieves the created ticket with posts', async () => {
    const res = await staffRequest.get(`/api/tickets/${ticketId}`).expect(200);

    const body = res.body as {
      id: number;
      posts: unknown[];
      tags: Array<{ name: string }>;
      totalReplies: number;
    };
    expect(body.id).toBe(ticketId);
    expect(body.posts).toHaveLength(1);
    ticketTotalRepliesAfterCreate = body.totalReplies;
    expect(ticketTotalRepliesAfterCreate).toBe(1);
  });

  it('POST /api/tickets/:id/reply — adds a staff reply', async () => {
    await staffRequest
      .post(`/api/tickets/${ticketId}/reply`)
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Token', csrfToken)
      .send({
        contents: 'This is a staff reply.',
        isHtml: false,
        isNote: false,
        creationMode: 'STAFF',
        ipAddress: '127.0.0.1',
      })
      .expect(201);
  });

  it('GET /api/tickets/:id — now has 2 posts and totalReplies incremented after reply', async () => {
    const res = await staffRequest.get(`/api/tickets/${ticketId}`).expect(200);

    const body = res.body as { posts: unknown[]; totalReplies: number };
    expect(body.posts).toHaveLength(2);
    expect(body.totalReplies).toBe(ticketTotalRepliesAfterCreate + 1);
  });

  it('GET /api/tickets — lists tickets with pagination', async () => {
    const res = await staffRequest.get('/api/tickets?page=1&limit=10').expect(200);

    const body = res.body as { data: unknown[]; total: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /api/tickets/:id/status — changes status', async () => {
    const res = await staffRequest
      .patch(`/api/tickets/${ticketId}/status`)
      .set('Origin', 'http://localhost:3000')
      .set('X-CSRF-Token', csrfToken)
      .send({ statusId: 2 }) // Pending
      .expect(200);

    const body = res.body as { statusId: number };
    expect(body.statusId).toBe(2);
  });

  it('POST /api/tickets/public — creates a second ticket without auth', async () => {
    const res = await publicRequest
      .post('/api/tickets/public')
      .send({
        challengeToken: 'integration-test-bypass',
        subject: 'Public portal ticket',
        contents: 'Submitted from the client portal.',
        requesterEmail: 'portal@external.example',
        requesterName: 'Portal User',
        customFields: {},
      })
      .expect(201);

    const body = res.body as { mask: string };
    expect(body.mask).toMatch(/^TT-\d{6,}$/);
  });
});
