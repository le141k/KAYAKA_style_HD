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

// Lazy import to avoid crashing when testcontainers is not installed
let PostgreSqlContainerCtor: typeof PostgreSqlContainer;

let container: StartedPostgreSqlContainer;
let app: INestApplication;
let request: ReturnType<typeof supertest>;

/** JWT token for the admin staff (obtained via /auth/login after seeding). */
let adminToken: string;

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
  process.env['DATABASE_URL'] = databaseUrl;
  process.env['TELECOM_HD_JWT_ACCESS_SECRET'] = 'int-test-access-secret-32chars!!';
  process.env['TELECOM_HD_JWT_REFRESH_SECRET'] = 'int-test-refresh-secret-32chars!!';

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

  request = supertest(app.getHttpServer());

  // ── 5. Log in as admin to get JWT ───────────────────────────────────────────
  const loginRes = await request
    .post('/api/auth/login')
    .send({ email: 'admin@23telecom.example', password: 'demo1234' })
    .expect(200);

  adminToken = (loginRes.body as { accessToken: string }).accessToken;
  expect(adminToken).toBeTruthy();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await container?.stop();
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
    const res = await request
      .post('/api/tickets/public')
      .send({
        subject: 'Integration test ticket',
        contents: 'This is the initial post body.',
        requesterEmail: 'inttest@example.com',
        requesterName: 'Integration Tester',
        customFields: {},
      })
      .expect(201);

    const body = res.body as { id: number; mask: string; subject: string; totalReplies: number };
    expect(body.mask).toMatch(/^TT-\d{6,}$/);
    expect(body.subject).toBe('Integration test ticket');
    ticketId = body.id;
    ticketTotalRepliesAfterCreate = body.totalReplies;
    expect(ticketTotalRepliesAfterCreate).toBe(1);
  });

  it('GET /api/tickets/:id — retrieves the created ticket with posts', async () => {
    const res = await request
      .get(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as { id: number; posts: unknown[]; tags: Array<{ name: string }> };
    expect(body.id).toBe(ticketId);
    expect(body.posts).toHaveLength(1);
  });

  it('POST /api/tickets/:id/reply — adds a staff reply', async () => {
    await request
      .post(`/api/tickets/${ticketId}/reply`)
      .set('Authorization', `Bearer ${adminToken}`)
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
    const res = await request
      .get(`/api/tickets/${ticketId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as { posts: unknown[]; totalReplies: number };
    expect(body.posts).toHaveLength(2);
    expect(body.totalReplies).toBe(ticketTotalRepliesAfterCreate + 1);
  });

  it('GET /api/tickets — lists tickets with pagination', async () => {
    const res = await request
      .get('/api/tickets?page=1&limit=10')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = res.body as { data: unknown[]; total: number };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it('PATCH /api/tickets/:id/status — changes status', async () => {
    const res = await request
      .patch(`/api/tickets/${ticketId}/status`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ statusId: 2 }) // Pending
      .expect(200);

    const body = res.body as { statusId: number };
    expect(body.statusId).toBe(2);
  });

  it('POST /api/tickets/public — creates a second ticket without auth', async () => {
    const res = await request
      .post('/api/tickets/public')
      .send({
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
