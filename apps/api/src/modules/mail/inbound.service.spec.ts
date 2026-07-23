/**
 * Tests for InboundMailService parser rule helpers:
 *   - evaluateCriteria (ALL / ANY / regex)
 *   - applyParserRules (skip / route / stop-processing)
 *   - processMessage discard path (via applyParserRules mock)
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { InboundMailService } from './inbound.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TicketsService } from '../tickets/tickets.service';
import type { MailService } from './mail.service';
import type { AppConfig } from '../../config/configuration';
import type { InboundRawStorageService } from './inbound-raw-storage.service';
import { MailAccessPolicy } from './mail-access-policy.service';

// Fake ImapFlow so connectQueue() can be exercised without a real IMAP server. The
// mailbox advertises UIDVALIDITY/UIDNEXT so the connect-time bootstrap barrier runs.
vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidValidity: 7n, uidNext: 10, exists: 0 };
    connect() {
      return Promise.resolve();
    }
    list() {
      return Promise.resolve([
        { path: 'Helpdesk/Test', pathAsListed: 'Helpdesk/Test', listed: true, flags: new Set() },
      ]);
    }
    getMailboxLock() {
      return Promise.resolve({ release: () => undefined });
    }
    logout() {
      return Promise.resolve();
    }
  },
}));

const TEST_CONFIG: AppConfig = {
  NODE_ENV: 'test',
  TELECOM_HD_API_PORT: 4000,
  TELECOM_HD_PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  TELECOM_HD_JWT_ACCESS_SECRET: 'test-access-secret-32chars-minimum',
  TELECOM_HD_JWT_REFRESH_SECRET: 'test-refresh-secret-32chars-min',
  TELECOM_HD_JWT_ACCESS_TTL: 900,
  TELECOM_HD_JWT_REFRESH_TTL: 2592000,
  TELECOM_HD_SMTP_HOST: 'localhost',
  TELECOM_HD_SMTP_PORT: 1025,
  TELECOM_HD_SMTP_SECURE: false,
  TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: false,
  TELECOM_HD_MAIL_FROM: 'support@test.example',
  TELECOM_HD_LOG_LEVEL: 'silent',
  TELECOM_HD_ALARIS_WEBHOOK_SECRET: 'test-secret',
  TELECOM_HD_INBOUND_WEBHOOK_SECRET: 'test-inbound-secret',
  TELECOM_HD_UPLOAD_DIR: '/tmp/uploads',
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
  TELECOM_HD_CLAMAV_ENABLED: false,
  TELECOM_HD_CLAMAV_HOST: 'clamav',
  TELECOM_HD_CLAMAV_PORT: 3310,
  TELECOM_HD_CLAMAV_TIMEOUT_MS: 15000,
  TELECOM_HD_CLIENT_PORTAL_ENABLED: false,
  // Most service tests exercise the accepted delivery pipeline. The production default
  // is closed; fixtures opt in explicitly so a missing config field can never hide it.
  TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
  TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: false,
  TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: undefined,
  TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
  TELECOM_HD_IMAP_ENABLED: false,
  TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'FROM_NOW',
  TELECOM_HD_IMAP_BACKFILL_LIMIT: 0,
  TELECOM_HD_INBOUND_MAX_ATTEMPTS: 5,
  TELECOM_HD_INBOUND_RAW_RETENTION_DAYS: 30,
  TELECOM_HD_FIELD_ENCRYPTION_KEY: 'a'.repeat(64),
};

function makePrismaMock() {
  // Keep logical claims stateful by default. A stateless `findUnique: null` mock would
  // falsely make every `INSERT .. ON CONFLICT DO NOTHING` look like a database outage,
  // hiding the winner/loser behavior that PostgreSQL provides in production.
  const claims = new Map<string, Record<string, unknown>>();
  const prisma = {
    emailQueue: {
      // Acceptance snapshots must contain the same enabled queue row that the SQL acceptance
      // fence locked. Individual routing/supervisor tests replace this fixture as needed.
      findMany: vi.fn().mockResolvedValue([
        {
          id: 1,
          emailAddress: 'support@example.com',
          departmentId: null,
          routingPriority: 100,
          sendAutoresponder: false,
          captureRetiredAt: null,
        },
      ]),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    departmentStaff: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    emailParserRule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ticketPost: { findFirst: vi.fn(), update: vi.fn() },
    ticket: { findUnique: vi.fn() },
    inboundDelivery: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // Large raw MIME is fenced by this staging row until the acceptance transaction
    // owns both the row and the InboundDelivery insert. Keep it present in the shared
    // interactive-transaction mock so a unit test cannot accidentally bypass the fence.
    inboundRawMimeStaging: {
      create: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inboundMessageClaim: {
      findUnique: vi.fn(({ where }: { where: { messageIdHash: string } }) =>
        Promise.resolve(claims.get(where.messageIdHash) ?? null),
      ),
      createMany: vi.fn(({ data }: { data: Record<string, unknown> }) => {
        const messageIdHash = data.messageIdHash as string;
        if (claims.has(messageIdHash)) return Promise.resolve({ count: 0 });
        claims.set(messageIdHash, { ...data });
        return Promise.resolve({ count: 1 });
      }),
      // Retained only for older non-P1-E test helpers; runtime claim code must use
      // createMany(skipDuplicates), never catch P2002 inside an interactive transaction.
      create: vi
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    inboundAuditLog: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
    },
    department: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    // Acceptance fence raw query — default to the matching queue row.
    $queryRaw: vi.fn().mockResolvedValue([
      {
        id: 1,
        emailAddress: 'support@example.com',
        departmentId: null,
        sendAutoresponder: false,
        configGeneration: 0,
        captureRetiredAt: null,
      },
    ]),
  };
  // Interactive transactions execute against the same mock delegates. This keeps tests close
  // to the real atomic logical-claim path rather than falsely bypassing it.
  Object.assign(prisma, {
    $transaction: vi.fn(async (input: unknown) => {
      if (typeof input === 'function') {
        return (input as (tx: typeof prisma) => Promise<unknown>)(prisma);
      }
      return Promise.all(input as Promise<unknown>[]);
    }),
  });
  (prisma.emailQueue.findFirst as ReturnType<typeof vi.fn>).mockImplementation((args: unknown) =>
    (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)(args),
  );
  return prisma as unknown as PrismaService;
}

function makeInboundService(
  prisma: PrismaService,
  config: AppConfig = TEST_CONFIG,
  rawStorage?: InboundRawStorageService,
): InboundMailService {
  const ticketsService = {
    reply: vi.fn().mockResolvedValue({ id: 1 }),
    getTicketByMask: vi.fn(),
    createTicket: vi.fn().mockResolvedValue({ id: 1, mask: 'TT-000001', subject: 'test' }),
  } as unknown as TicketsService;

  const mailService = {
    sendTemplate: vi.fn().mockResolvedValue(undefined),
  } as unknown as MailService;

  return new InboundMailService(
    config,
    prisma,
    ticketsService,
    mailService,
    undefined, // attachmentsService
    rawStorage,
  );
}

// ─────────────────────────────────────────────────────────────────────────────

describe('InboundMailService — parser rule helpers', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: InboundMailService;

  const parsedBase = {
    subject: 'Hello from SPAM',
    fromEmail: 'spammer@evil.example',
    fromName: 'Spammer',
    toEmail: 'support@23telecom.example',
    body: 'Buy cheap goods now',
  };

  beforeEach(() => {
    prisma = makePrismaMock();
    service = makeInboundService(prisma as unknown as PrismaService);
  });

  // ─── evaluateCriteria ──────────────────────────────────────────────────────

  describe('evaluateCriteria', () => {
    it('returns true when criteria is empty', () => {
      expect(service.evaluateCriteria(parsedBase, [], 'ALL')).toBe(true);
      expect(service.evaluateCriteria(parsedBase, [], 'ANY')).toBe(true);
    });

    it('ALL: returns true only when all criteria match', () => {
      const criteria = [
        { field: 'subject', op: 'contains', value: 'SPAM' },
        { field: 'sender', op: 'eq', value: 'spammer@evil.example' },
      ];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(true);
    });

    it('ALL: returns false when one criterion does not match', () => {
      const criteria = [
        { field: 'subject', op: 'contains', value: 'SPAM' },
        { field: 'sender', op: 'eq', value: 'legit@example.com' }, // wrong email
      ];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(false);
    });

    it('ANY: returns true when at least one criterion matches', () => {
      const criteria = [
        { field: 'subject', op: 'contains', value: 'SPAM' }, // matches
        { field: 'sender', op: 'eq', value: 'legit@example.com' }, // does not match
      ];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ANY')).toBe(true);
    });

    it('ANY: returns false when no criterion matches', () => {
      const criteria = [
        { field: 'subject', op: 'contains', value: 'INVOICE' },
        { field: 'sender', op: 'eq', value: 'legit@example.com' },
      ];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ANY')).toBe(false);
    });

    it('op:regex — matches a regex pattern', () => {
      const criteria = [{ field: 'subject', op: 'regex', value: '^Hello .* SPAM$' }];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(true);
    });

    it('op:regex — invalid regex returns false without throwing', () => {
      const criteria = [{ field: 'subject', op: 'regex', value: '[invalid' }];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(false);
    });

    it('op:not_contains — matches when value absent', () => {
      const criteria = [{ field: 'body', op: 'not_contains', value: 'legitimate' }];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(true);
    });

    it('op:starts_with — matches subject prefix', () => {
      const criteria = [{ field: 'subject', op: 'starts_with', value: 'Hello' }];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(true);
    });

    it('op:ends_with — matches subject suffix', () => {
      const criteria = [{ field: 'subject', op: 'ends_with', value: 'SPAM' }];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(true);
    });

    it('op:regex — a safe start-anchored pattern matches', () => {
      const criteria = [{ field: 'subject', op: 'regex', value: '^Hello' }];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(true);
    });

    it('op:regex — a catastrophic-backtracking pattern is rejected by the ReDoS guard (no match, no hang)', () => {
      // `(a+)+$` is classic ReDoS. isSafeRuleRegex must reject it (groups disallowed) BEFORE
      // it is compiled, so an attacker-controlled inbound body can never trigger backtracking.
      const criteria = [{ field: 'subject', op: 'regex', value: '(a+)+$' }];
      expect(service.evaluateCriteria(parsedBase, criteria, 'ALL')).toBe(false);
    });
  });

  // ─── applyParserRules ──────────────────────────────────────────────────────

  describe('applyParserRules', () => {
    it('returns default result when no rules exist', async () => {
      (prisma.emailParserRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const result = await service.applyParserRules(parsedBase, 1);
      expect(result).toEqual({ skip: false, tags: [] });
    });

    it('skip action discards the message', async () => {
      (prisma.emailParserRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 1,
          title: 'Spam filter',
          ruleType: 'PRE_PARSE',
          matchType: 'ALL',
          stopProcessing: false,
          isEnabled: true,
          sortOrder: 0,
          criteria: [{ field: 'subject', op: 'contains', value: 'SPAM' }],
          actions: [{ type: 'ignore' }],
        },
      ]);
      const result = await service.applyParserRules(parsedBase, 1);
      expect(result.skip).toBe(true);
    });

    it('route_dept action overrides departmentId', async () => {
      (prisma.emailParserRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 2,
          title: 'Route to NOC',
          ruleType: 'PRE_PARSE',
          matchType: 'ALL',
          stopProcessing: false,
          isEnabled: true,
          sortOrder: 0,
          criteria: [{ field: 'subject', op: 'contains', value: 'SPAM' }],
          actions: [{ type: 'route_dept', value: 5 }],
        },
      ]);
      const result = await service.applyParserRules(parsedBase, 1);
      expect(result.skip).toBe(false);
      expect(result.departmentId).toBe(5);
    });

    it('add_tag action populates tags array', async () => {
      (prisma.emailParserRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 3,
          title: 'Tag spam',
          ruleType: 'PRE_PARSE',
          matchType: 'ALL',
          stopProcessing: false,
          isEnabled: true,
          sortOrder: 0,
          criteria: [{ field: 'subject', op: 'contains', value: 'SPAM' }],
          actions: [{ type: 'add_tag', value: 'spam' }],
        },
      ]);
      const result = await service.applyParserRules(parsedBase, 1);
      expect(result.tags).toContain('spam');
    });

    it('stopProcessing halts subsequent rule evaluation', async () => {
      (prisma.emailParserRule.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 4,
          title: 'First rule (stop)',
          ruleType: 'PRE_PARSE',
          matchType: 'ALL',
          stopProcessing: true,
          isEnabled: true,
          sortOrder: 0,
          criteria: [{ field: 'subject', op: 'contains', value: 'SPAM' }],
          actions: [{ type: 'route_dept', value: 2 }],
        },
        {
          id: 5,
          title: 'Second rule (should not run)',
          ruleType: 'PRE_PARSE',
          matchType: 'ALL',
          stopProcessing: false,
          isEnabled: true,
          sortOrder: 1,
          criteria: [{ field: 'subject', op: 'contains', value: 'SPAM' }],
          actions: [{ type: 'ignore' }],
        },
      ]);
      const result = await service.applyParserRules(parsedBase, 1);
      // First rule routes; stops — second rule's ignore should NOT run
      expect(result.skip).toBe(false);
      expect(result.departmentId).toBe(2);
    });

    it('gracefully returns default result when DB throws (table missing)', async () => {
      (prisma.emailParserRule.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('relation "EmailParserRule" does not exist'),
      );
      const result = await service.applyParserRules(parsedBase, 1);
      expect(result).toEqual({ skip: false, tags: [] });
    });
  });

  // ─── routing: dedup (A3) + subject-mask ownership + fail-closed mask ──────────

  type RoutingSvc = {
    processRawMessage: (
      m: Buffer,
      d: number | undefined,
      opts?: {
        deliveryId?: number;
        legacyDedupIds?: string[];
        syntheticSeed?: string;
        deliveryContext?: {
          queueId?: number;
          transportKey?: string;
          envelopeTo?: string;
          routedQueueId?: number;
          routedDepartmentId?: number;
          sendAutoresponder?: boolean | null;
          routingSnapshot?: Array<{
            id: number;
            emailAddress: string;
            departmentId: number | null;
            routingPriority: number;
            sendAutoresponder: boolean;
          }>;
        };
      },
    ) => Promise<{ state: string; ticketId?: number; postId?: number }>;
    ticketsService: {
      createTicket: ReturnType<typeof vi.fn>;
      reply: ReturnType<typeof vi.fn>;
      getTicketByMask: ReturnType<typeof vi.fn>;
    };
  };

  describe('processRawMessage — dedup + mask routing', () => {
    const rawEmail = [
      'From: customer@acme.example',
      'To: support@test.example',
      'Subject: Need help',
      'Message-ID: <dup-123@acme.example>',
      '',
      'Body text',
      '',
    ].join('\r\n');

    const svcOf = () => makeInboundService(prisma as unknown as PrismaService) as unknown as RoutingSvc;

    it('skips (SKIPPED) a message whose inbound Message-ID already exists on a post', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99, ticketId: 7 });
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(rawEmail), 1);
      expect(out.state).toBe('SKIPPED');
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
      expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { inboundMessageId: { in: ['<dup-123@acme.example>'] } } }),
      );
    });

    it('creates a ticket (PROCESSED) passing the real Message-ID atomically when it is new', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(rawEmail), 1);
      expect(out.state).toBe('PROCESSED');
      expect(svc.ticketsService.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ incomingMessageId: '<dup-123@acme.example>' }),
      );
    });

    it('does not let a staff outbound threading Message-ID suppress an inbound delivery', async () => {
      const spoofedId = '<dup-123@acme.example>';
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: Record<string, unknown> }) => {
          // Before the split, the generic `messageId` lookup found this staff post and
          // returned SKIPPED. Only the inbound idempotency column may answer this query.
          if (where.messageId) return Promise.resolve({ id: 91, ticketId: 9, inboundMessageId: null });
          return Promise.resolve(null);
        },
      );
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(rawEmail), 1);

      expect(out.state).toBe('PROCESSED');
      expect(svc.ticketsService.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ incomingMessageId: spoofedId }),
      );
      expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { inboundMessageId: { in: [spoofedId] } } }),
      );
    });

    it('P1-E: writes non-unique observed identity and a durable logical Message-ID claim', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(rawEmail), 1, { deliveryId: 77 });
      expect(prisma.inboundMessageClaim.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            normalizedMessageId: '<dup-123@acme.example>',
            winnerDeliveryId: 77,
            semanticHashVersion: 1,
          }),
          skipDuplicates: true,
        }),
      );
      expect(prisma.inboundDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 77 },
          data: expect.objectContaining({
            observedMessageId: '<dup-123@acme.example>',
            envelopeFrom: 'customer@acme.example',
            subject: 'Need help',
          }),
        }),
      );
    });

    it('P1-E: a concurrent same-semantic Message-ID loses the claim race → SKIPPED, no ticket', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      let racingClaim: Record<string, unknown> | null = null;
      (prisma.inboundMessageClaim.createMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          racingClaim = { ...data, winnerDeliveryId: 88 };
          return Promise.resolve({ count: 0 });
        },
      );
      (prisma.inboundMessageClaim.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(racingClaim),
      );
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(rawEmail), 1, { deliveryId: 77 });
      expect(out.state).toBe('SKIPPED');
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
    });

    it('a same-Message-ID delivery is SKIPPED, not quarantined, even when the raw bytes differ', async () => {
      // A message CC'd to two IMAP-polled mailboxes gets per-hop Received/Delivered-To trace
      // headers, so the two stored copies differ byte-for-byte while sharing one Message-ID.
      // It is ONE logical message → SKIP the second copy; NEVER quarantine it as a "spoof".
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      let storedClaim: Record<string, unknown> | null = null;
      (prisma.inboundMessageClaim.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(storedClaim),
      );
      (prisma.inboundMessageClaim.createMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          if (storedClaim) return Promise.resolve({ count: 0 });
          storedClaim = { ...data };
          return Promise.resolve({ count: 1 });
        },
      );
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(rawEmail), 1, { deliveryId: 77 });
      const perHopCopy = [
        'Received: from mta-2.example by mx.example',
        'Delivered-To: support@test.example',
        rawEmail,
      ].join('\r\n');
      const out = await svc.processRawMessage(Buffer.from(perHopCopy), 1, { deliveryId: 78 });
      expect(out.state).toBe('SKIPPED');
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
    });

    it('P1-E: same real Message-ID with different logical content is audited and fail-closed', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      let storedClaim: Record<string, unknown> | null = null;
      (prisma.inboundMessageClaim.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(storedClaim),
      );
      (prisma.inboundMessageClaim.createMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          if (storedClaim) return Promise.resolve({ count: 0 });
          storedClaim = { ...data };
          return Promise.resolve({ count: 1 });
        },
      );
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(rawEmail), 1, { deliveryId: 77 });
      const changedBody = rawEmail.replace('Body text', 'This is a different logical body');
      await expect(svc.processRawMessage(Buffer.from(changedBody), 1, { deliveryId: 78 })).rejects.toThrow(
        'Message-ID was already claimed',
      );
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'mail.message_id_conflict',
            deliveryId: 78,
          }),
        }),
      );
      expect(prisma.inboundDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 78 },
          data: expect.objectContaining({ observedMessageId: '<dup-123@acme.example>' }),
        }),
      );
    });

    it('scopes the synthetic id per queue so identical-byte mail to DIFFERENT queues is both ticketed', async () => {
      const noId = ['From: a@b.example', 'To: s@t.example', 'Subject: hi', '', 'body', ''].join('\r\n');
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      // Same raw bytes, two queues (distinct seeds) → distinct ids → both create a ticket.
      await svc.processRawMessage(Buffer.from(noId), 1, { deliveryId: 1, syntheticSeed: 'imap:1:HASH' });
      await svc.processRawMessage(Buffer.from(noId), 1, { deliveryId: 2, syntheticSeed: 'imap:2:HASH' });
      const calls = (svc.ticketsService.createTicket as ReturnType<typeof vi.fn>).mock.calls as Array<
        [{ incomingMessageId: string }]
      >;
      expect(calls).toHaveLength(2);
      expect(calls[0]![0].incomingMessageId).not.toBe(calls[1]![0].incomingMessageId);
    });

    it('P1-E: headerless mail is NOT content-deduplicated across different IMAP transport identities', async () => {
      const noId = ['From: a@b.example', 'To: s@t.example', 'Subject: hi', '', 'body', ''].join('\r\n');
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      // Same bytes but distinct UID transport keys are two independent logical deliveries.
      await svc.processRawMessage(Buffer.from(noId), 1, { deliveryId: 1, syntheticSeed: 'imap:1:42:100' });
      const first = (svc.ticketsService.createTicket as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        incomingMessageId: string;
      };
      await svc.processRawMessage(Buffer.from(noId), 1, { deliveryId: 2, syntheticSeed: 'imap:1:42:101' });
      const second = (svc.ticketsService.createTicket as ReturnType<typeof vi.fn>).mock.calls[1]![0] as {
        incomingMessageId: string;
      };
      expect(first.incomingMessageId).not.toBe(second.incomingMessageId);
    });

    it.each([
      ['empty', 'Message-ID:'],
      ['unbracketed', 'Message-ID: broken-id@example.test'],
      ['oversized', `Message-ID: <${'x'.repeat(600)}@example.test>`],
    ])(
      'P1-E: a present but %s Message-ID is rejected, never silently treated as headerless',
      async (_kind, messageIdHeader) => {
        const malformed = [
          'From: a@b.example',
          'To: s@t.example',
          'Subject: malformed id',
          messageIdHeader,
          '',
          'body',
          '',
        ].join('\r\n');
        (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const svc = svcOf();

        await expect(svc.processRawMessage(Buffer.from(malformed), 1, { deliveryId: 87 })).rejects.toThrow(
          'Message-ID is invalid or too long',
        );
        expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
        expect(svc.ticketsService.reply).not.toHaveBeenCalled();
        expect(prisma.inboundMessageClaim.createMany).not.toHaveBeenCalled();
      },
    );

    it('P1-E: a headerless retry of the SAME transport key produces only one ticket post', async () => {
      const noId = ['From: a@b.example', 'To: s@t.example', 'Subject: hi', '', 'body', ''].join('\r\n');
      let existing = false;
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(existing ? { id: 901, ticketId: 91 } : null),
      );
      const svc = svcOf();
      const opts = { deliveryId: 1, syntheticSeed: 'imap:1:7:42:100' };
      await svc.processRawMessage(Buffer.from(noId), 1, opts);
      existing = true;
      const retry = await svc.processRawMessage(Buffer.from(noId), 1, opts);
      expect(retry).toMatchObject({ state: 'SKIPPED', ticketId: 91, postId: 901 });
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['IMAP high-priority copy drains first', 'imap', ['q1', 'q2']],
      ['IMAP low-priority copy drains first', 'imap', ['q2', 'q1']],
      ['PIPE high-priority copy drains first', 'pipe', ['q1', 'q2']],
      ['PIPE low-priority copy drains first', 'pipe', ['q2', 'q1']],
    ] as const)(
      'P1-E: immutable routing snapshot chooses the same owner when %s',
      async (_scenario, transport, order) => {
        // q1 and q2 are two accepted transport copies of ONE RFC Message-ID. The visible
        // recipients match both, but q2 wins by lower routingPriority. This must hold even
        // when q1's drain claims the durable Message-ID first.
        const localPrisma = makePrismaMock();
        (localPrisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const localSvc = makeInboundService(localPrisma as unknown as PrismaService) as unknown as RoutingSvc;
        const snapshot = [
          {
            id: 1,
            emailAddress: 'priority-100@example.test',
            departmentId: 11,
            routingPriority: 100,
            sendAutoresponder: false,
          },
          {
            id: 2,
            emailAddress: 'priority-5@example.test',
            departmentId: 22,
            routingPriority: 5,
            sendAutoresponder: true,
          },
        ];
        const mail = Buffer.from(
          rawEmail
            .replace('To: support@test.example', 'To: priority-100@example.test, priority-5@example.test')
            .replace('dup-123', 'cc-priority-race'),
        );
        const copies = {
          q1: {
            deliveryId: 101,
            departmentId: 11,
            context: {
              queueId: 1,
              envelopeTo: 'priority-100@example.test',
              transportKey: `${transport}:1:1:7:101`,
              routingSnapshot: snapshot,
            },
          },
          q2: {
            deliveryId: 102,
            departmentId: 22,
            context: {
              queueId: 2,
              envelopeTo: 'priority-5@example.test',
              transportKey: `${transport}:2:1:7:102`,
              routingSnapshot: snapshot,
            },
          },
        };

        for (const copyName of order) {
          const copy = copies[copyName];
          await localSvc.processRawMessage(mail, copy.departmentId, {
            deliveryId: copy.deliveryId,
            deliveryContext: copy.context,
          });
        }

        const claimRows = (localPrisma.inboundMessageClaim.createMany as ReturnType<typeof vi.fn>).mock.calls;
        expect(claimRows).toHaveLength(2);
        expect((claimRows[0]?.[0] as { data: unknown }).data).toEqual(
          expect.objectContaining({ routedQueueId: 2, departmentId: 22 }),
        );
        expect(localSvc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
        expect(localSvc.ticketsService.createTicket).toHaveBeenCalledWith(
          expect.objectContaining({
            departmentId: 22,
            inboundQueueId: 2,
            inboundSendAutoresponder: true,
          }),
        );
        // The drain must not look at today's live queue configuration after acceptance.
        expect(localPrisma.emailQueue.findMany).not.toHaveBeenCalled();
      },
    );

    it('uses the trusted envelope recipient from the snapshot for a headerless BCC copy', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      const bccCopy = rawEmail.replace('To: support@test.example\r\n', '').replace('dup-123', 'bcc-route-1');
      await svc.processRawMessage(Buffer.from(bccCopy), 8, {
        deliveryId: 103,
        deliveryContext: {
          queueId: 8,
          envelopeTo: 'bcc@example.test',
          transportKey: 'imap:8:1:7:103',
          routingSnapshot: [
            {
              id: 8,
              emailAddress: 'visible@example.test',
              departmentId: 8,
              routingPriority: 100,
              sendAutoresponder: false,
            },
            {
              id: 2,
              emailAddress: 'bcc@example.test',
              departmentId: 22,
              routingPriority: 5,
              sendAutoresponder: true,
            },
          ],
        },
      });

      expect(prisma.inboundMessageClaim.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ routedQueueId: 2, departmentId: 22 }),
        }),
      );
      expect(svc.ticketsService.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ departmentId: 22, inboundQueueId: 2, inboundSendAutoresponder: true }),
      );
      expect(prisma.emailQueue.findMany).not.toHaveBeenCalled();
    });

    it('keeps a queued ledger delivery on its persisted route after the accepting queue was deleted', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(rawEmail.replace('dup-123', 'deleted-queue-route')), 9, {
        deliveryId: 105,
        // Queue foreign keys are nullable by design after operator deletion. The immutable
        // transport key + snapshot must still prove this is a ledger row, never a direct
        // caller permitted to read today's enabled queues.
        deliveryContext: {
          transportKey: 'imap:deleted-queue:1:7:105',
          envelopeTo: 'persisted@example.test',
          routingSnapshot: [
            {
              id: 9,
              emailAddress: 'support@test.example',
              departmentId: 9,
              routingPriority: 10,
              sendAutoresponder: false,
            },
          ],
        },
      });

      expect(svc.ticketsService.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ departmentId: 9, inboundQueueId: 9, inboundSendAutoresponder: false }),
      );
      expect(prisma.emailQueue.findMany).not.toHaveBeenCalled();
    });

    it('passes the acceptance-time autoresponder policy to new-ticket creation', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();

      await svc.processRawMessage(Buffer.from(rawEmail.replace('dup-123', 'auto-policy-1')), 12, {
        deliveryId: 104,
        deliveryContext: {
          queueId: 7,
          routedQueueId: 7,
          routedDepartmentId: 12,
          sendAutoresponder: true,
          transportKey: 'imap:7:1:7:104',
        },
      });

      expect(svc.ticketsService.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({
          departmentId: 12,
          inboundQueueId: 7,
          inboundSendAutoresponder: true,
        }),
      );
    });

    it('synthesises a deterministic Message-ID from content when the mail carries none', async () => {
      const noId = ['From: a@b.example', 'To: s@t.example', 'Subject: hi', '', 'body', ''].join('\r\n');
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(noId), 1);
      const arg = (svc.ticketsService.createTicket as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        incomingMessageId: string;
      };
      // Deterministic synthetic id → a retry of the same bytes dedups to the same post.
      expect(arg.incomingMessageId).toMatch(/^<inbound-[0-9a-f]{64}@23telecom\.local>$/);
      expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { inboundMessageId: { in: [arg.incomingMessageId] } } }),
      );
    });

    const maskEmail = (from: string) =>
      [
        `From: ${from}`,
        'To: support@test.example',
        'Subject: Re: TT-000005 still broken',
        `Message-ID: <mask-${from}@x.example>`,
        '',
        'still broken',
        '',
      ].join('\r\n');

    it('does NOT thread by mask when the sender is not a ticket participant → new ticket', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 5,
        requesterEmail: 'owner@acme.example',
        user: null,
        recipients: [],
      });
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(maskEmail('attacker@evil.example')), 1);
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
    });

    it('threads by mask (reply) when the sender IS an authorized participant', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 5,
        requesterEmail: 'owner@acme.example',
        user: null,
        recipients: [],
      });
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(maskEmail('owner@acme.example')), 1);
      expect(out.state).toBe('PROCESSED');
      expect(svc.ticketsService.reply).toHaveBeenCalledTimes(1);
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
    });

    it('authorizes a mask reply by a linked user email / recipient (not just requesterEmail)', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 5,
        requesterEmail: 'someone-else@acme.example',
        user: { emails: [{ email: 'owner@acme.example' }] },
        recipients: [{ email: 'cc@acme.example' }],
      });
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(maskEmail('cc@acme.example')), 1);
      expect(out.state).toBe('PROCESSED');
      expect(svc.ticketsService.reply).toHaveBeenCalledTimes(1);
    });

    it('authorizes a mask reply by a linked USER-ACCOUNT email that differs from requesterEmail', async () => {
      // Exercises the ticket.user.emails branch of senderCanReply specifically: the sender is
      // NOT the requesterEmail and NOT a recipient — only the linked account email matches.
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 5,
        requesterEmail: 'someone-else@acme.example',
        user: { emails: [{ email: 'owner@acme.example' }] },
        recipients: [],
      });
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(maskEmail('owner@acme.example')), 1);
      expect(out.state).toBe('PROCESSED');
      expect(svc.ticketsService.reply).toHaveBeenCalledTimes(1);
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
    });

    it('IN-10: an unresolved mask → new ticket (never a silent thread)', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(maskEmail('owner@acme.example')), 1);
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
    });

    it('IN-10: a DB error from mask lookup propagates (no silent duplicate ticket)', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db timeout'));
      const svc = svcOf();
      await expect(svc.processRawMessage(Buffer.from(maskEmail('owner@acme.example')), 1)).rejects.toThrow(
        'db timeout',
      );
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
    });
  });

  // ─── durable ledger: accept (poll) + drain ───────────────────────────────────

  describe('pollQueue — durable accept (no silent loss, fail-closed)', () => {
    /** Deterministic raw bytes for a UID — reused by tests to assert stored rawMime/hash. */
    const imapSrc = (uid: number) =>
      Buffer.from(`From: a@b.example\r\nMessage-ID: <m-${uid}@x>\r\n\r\nhi ${uid}`);

    /** Fake ImapFlow: uid-only `fetch` yields the ids; `fetchOne` returns the source. */
    function makeLedgerClient(
      uids: number[],
      mailbox: { uidValidity: bigint; uidNext?: number; exists?: number },
      opts: {
        vanish?: number[];
        fetchOneThrowsAt?: number;
        sourceForUid?: (uid: number) => Buffer;
        envelopeForUid?: (uid: number) => unknown;
      } = {},
    ) {
      const src = imapSrc;
      return {
        mailbox: { ...mailbox, exists: mailbox.exists ?? 0 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        // Capture-only now verifies the provider's live folder mapping before
        // it reads a body.  Keep this fake a normal selectable test folder;
        // unsafe/missing LIST mappings have their own explicit regression tests.
        list: vi
          .fn()
          .mockResolvedValue([
            { path: 'Helpdesk Test', pathAsListed: 'Helpdesk Test', listed: true, flags: new Set() },
          ]),
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: vi.fn(function* () {
          for (const uid of uids) yield { uid };
        }),
        fetchOne: vi.fn((uidStr: string) => {
          const uid = Number(uidStr);
          if (opts.fetchOneThrowsAt === uid) return Promise.reject(new Error('fetch reset'));
          if (opts.vanish?.includes(uid)) return Promise.resolve(false);
          return Promise.resolve({
            uid,
            source: opts.sourceForUid?.(uid) ?? src(uid),
            envelope: opts.envelopeForUid?.(uid),
          });
        }),
      };
    }

    const poll = (client: unknown) =>
      (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(1, client);

    function queue(over: Record<string, unknown> = {}) {
      return {
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        emailAddress: 'support@example.com',
        departmentId: null,
        sendAutoresponder: false,
        mailbox: 'INBOX',
        useTls: true,
        lastSeenUid: 100n,
        uidValidity: 7n,
        syncState: 'OK',
        lastError: null,
        cursorGeneration: 0,
        mailboxEpoch: 1,
        configGeneration: 0,
        reconcileCause: null,
        captureRetiredAt: null,
        ...over,
      };
    }

    function dedicatedCaptureQueue(over: Record<string, unknown> = {}) {
      return queue({ mailbox: 'Helpdesk Test', ...over });
    }

    function dedicatedCaptureLockRow() {
      return {
        id: 1,
        emailAddress: 'support@example.com',
        departmentId: null,
        sendAutoresponder: false,
        configGeneration: 0,
        mailbox: 'Helpdesk Test',
        captureRetiredAt: null,
      };
    }

    beforeEach(() => {
      // Drain finds nothing by default so these tests isolate the accept phase.
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    });

    it('accepts new UIDs into the ledger and advances the cursor via monotonic CAS', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dedicatedCaptureQueue());
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([dedicatedCaptureLockRow()]);
      const client = makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 });
      await poll(client);

      // IN-01: the discovery fetch is a real UID range — `{ uid: true }` is the THIRD arg
      // (folding it into the query object leaves it a *sequence* range).
      expect(client.fetch).toHaveBeenCalledWith('101:*', expect.anything(), { uid: true });
      expect(client.fetchOne).toHaveBeenCalledWith('102', expect.anything(), { uid: true });

      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledTimes(2);
      // The ACTUAL raw bytes / hash / size must be persisted (durable, replayable) — not
      // just the transport key.
      const src102 = imapSrc(102);
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transport: 'IMAP',
            transportKey: 'imap:1:1:7:102',
            mailboxEpoch: 1,
            rawMime: new Uint8Array(src102),
            contentHash: createHash('sha256').update(src102).digest('hex'),
            sizeBytes: src102.length,
          }),
        }),
      );
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 1,
            lastSeenUid: 100n,
            cursorGeneration: 0,
            mailboxEpoch: 1,
            syncState: 'OK',
          }),
          data: { lastSeenUid: 102n },
        }),
      );
    });

    it('selects the queue folder for polling and fences the cursor against that exact folder', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ mailbox: 'Helpdesk/Test' }),
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 1,
          emailAddress: 'support@example.com',
          departmentId: null,
          sendAutoresponder: false,
          configGeneration: 0,
          mailbox: 'Helpdesk/Test',
        },
      ]);
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });

      await poll(client);

      expect(client.getMailboxLock).toHaveBeenCalledWith('Helpdesk/Test');
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ mailbox: 'Helpdesk/Test' }) }),
      );
    });

    it('normal IMAP refuses a capture-retired queue before it fetches or accepts any message', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ captureRetiredAt: new Date() }),
      );
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });

      await poll(client);

      expect(client.getMailboxLock).not.toHaveBeenCalled();
      expect(client.fetch).not.toHaveBeenCalled();
      expect(client.fetchOne).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(
        (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls.some(
          ([args]) => args?.data?.lastSeenUid === 101n,
        ),
      ).toBe(false);
    });

    it('P0 capture-retirement fence: normal IMAP acceptance SQL requires captureRetiredAt IS NULL', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dedicatedCaptureQueue());
      // Make the fake database return the locked receiving queue only when the
      // production SELECT ... FOR UPDATE includes the normal lifecycle predicate.
      // Removing that predicate turns this test red at the durable insert, rather
      // than merely leaving a string assertion green.
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) =>
        Promise.resolve(query.sql?.includes('"captureRetiredAt" IS NULL') ? [dedicatedCaptureLockRow()] : []),
      );

      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));

      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledTimes(1);
      const [acceptanceQuery] = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
      expect((acceptanceQuery as { sql?: string }).sql).toContain('"captureRetiredAt" IS NULL');
    });

    it('P0 capture-retirement fence: a normal IMAP lock miss never creates an external raw-MIME reservation', async () => {
      // Model the only race the pre-fetch snapshot cannot exclude: capture retirement
      // commits after fetchOne() but before the transaction obtains its queue-row lock.
      // Inline bytes are deliberately prepared before that final lock, but they have no
      // filesystem side effect. Large bodies take their own queue-bound reservation; that
      // lifecycle is tested below with a durable staging-row assertion.
      const svc = makeInboundService(prisma as unknown as PrismaService);
      const persist = vi.spyOn(
        svc as unknown as {
          persistRawMime: (source: Buffer, queueId: number, capture: boolean) => Promise<unknown>;
        },
        'persistRawMime',
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

      const accept = (
        svc as unknown as {
          acceptImapMessage: (
            snapshot: Record<string, unknown>,
            uidValidity: bigint,
            uid: number,
            source: Buffer,
          ) => Promise<'accepted' | 'duplicate'>;
        }
      ).acceptImapMessage;

      await expect(accept.call(svc, dedicatedCaptureQueue(), 7n, 101, imapSrc(101))).rejects.toThrow(
        /changed before delivery acceptance/i,
      );

      expect(persist).toHaveBeenCalledWith(imapSrc(101), 1, false);
      expect(prisma.inboundRawMimeStaging.create).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
    });

    it('capture-only durably records the selected IMAP queue as CAPTURED, advances its cursor, and never wakes the drain', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dedicatedCaptureQueue());
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([dedicatedCaptureLockRow()]);
      const drain = vi.spyOn(
        capture as unknown as { drainDeliveries: () => Promise<void> },
        'drainDeliveries',
      );
      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }),
      );

      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'CAPTURED' }) }),
      );
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 101n } }),
      );
      expect(drain).not.toHaveBeenCalled();
      expect(prisma.ticketPost.findFirst).not.toHaveBeenCalled();
    });

    it('capture-only refuses a non-TLS queue before it fetches or stages any message bytes', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        dedicatedCaptureQueue({ useTls: false }),
      );
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });
      const persist = vi.spyOn(
        capture as unknown as { persistRawMime: (source: Buffer) => Promise<unknown> },
        'persistRawMime',
      );

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(client.fetch).not.toHaveBeenCalled();
      expect(client.fetchOne).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
    });

    it('capture-only stores only bounded IMAP envelope metadata for the operator preview', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dedicatedCaptureQueue());
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([dedicatedCaptureLockRow()]);

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        makeLedgerClient(
          [101],
          { uidValidity: 7n, uidNext: 102 },
          {
            envelopeForUid: () => ({
              subject: 'One\r\n capture-only\u0000 test',
              messageId: ' <capture-101@example.test> ',
              from: [{ address: ' Sender@Example.Test ' }],
            }),
          },
        ),
      );

      const [createArgs] =
        (prisma.inboundDelivery.createMany as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
      expect(createArgs).toEqual(
        expect.objectContaining({
          data: expect.objectContaining({
            state: 'CAPTURED',
            subject: 'One capture-only test',
            observedMessageId: '<capture-101@example.test>',
            envelopeFrom: 'sender@example.test',
          }),
        }),
      );
      expect((createArgs as { data: Record<string, unknown> }).data).not.toHaveProperty('messageId');
      expect(prisma.inboundMessageClaim.createMany).not.toHaveBeenCalled();
      expect(prisma.ticketPost.findFirst).not.toHaveBeenCalled();
    });

    it('capture-only omits invalid IMAP envelope identifiers instead of treating them as mail claims', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dedicatedCaptureQueue());
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([dedicatedCaptureLockRow()]);

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        makeLedgerClient(
          [101],
          { uidValidity: 7n, uidNext: 102 },
          {
            envelopeForUid: () => ({
              messageId: '<bad id@example.test>',
              from: [{ address: 'not-an-address' }],
            }),
          },
        ),
      );

      const [createArgs] =
        (prisma.inboundDelivery.createMany as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
      const data = (createArgs as { data: Record<string, unknown> }).data;
      expect(data).toEqual(expect.objectContaining({ state: 'CAPTURED' }));
      expect(data).not.toHaveProperty('observedMessageId');
      expect(data).not.toHaveProperty('envelopeFrom');
      expect(data).not.toHaveProperty('messageId');
      expect(prisma.inboundMessageClaim.createMany).not.toHaveBeenCalled();
    });

    it('capture-only stops before a second new IMAP message when its durable one-message limit is full', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
        TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
      });
      // A full queue can only be a reconnect to an already armed capture
      // queue. New capture targets must be completely fresh and are rejected
      // by armCaptureQueue before this advisory capacity read.
      const retiredAt = new Date();
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        dedicatedCaptureQueue({ captureRetiredAt: retiredAt }),
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...dedicatedCaptureLockRow(), captureRetiredAt: retiredAt },
      ]);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });
      const persist = vi.spyOn(
        capture as unknown as { persistRawMime: (source: Buffer) => Promise<unknown> },
        'persistRawMime',
      );

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(prisma.inboundDelivery.count).toHaveBeenCalledWith({
        where: { queueId: 1, state: { in: ['CAPTURED', 'QUARANTINED'] } },
      });
      // The advisory outer fence is intentionally before fetchOne/persistRawMime:
      // a full one-message test must not keep reading later raw mail into memory.
      expect(client.fetchOne).not.toHaveBeenCalled();
      expect(persist).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      // The capacity error is fail-closed: the cursor stays before the unaccepted UID,
      // so no later message can be silently skipped behind it.
      expect(
        (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls.some(
          ([args]) => args?.data?.lastSeenUid === 101n,
        ),
      ).toBe(false);
    });

    it('capture-only permits an exact IMAP retry at capacity without retaining a second copy', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
        TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
      });
      const source = imapSrc(101);
      const retiredAt = new Date();
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        dedicatedCaptureQueue({ captureRetiredAt: retiredAt }),
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { ...dedicatedCaptureLockRow(), captureRetiredAt: retiredAt },
      ]);
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        queueId: 1,
        mailboxEpoch: 1,
        uidValidity: 7n,
        uid: 101n,
        contentHash: createHash('sha256').update(source).digest('hex'),
      });
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }),
      );

      // At capacity we first make the cheap count/read check, then allow only the
      // known transport retry through to its content-hash verification.
      // The only count is the capacity check; an already-retired queue is not
      // armed a second time. The exact transport retry bypasses this limit in
      // the transactional accept path after its content hash is verified.
      expect(prisma.inboundDelivery.count).toHaveBeenCalledTimes(1);
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 101n } }),
      );
    });

    it('capture-only refuses to arm a queue with any prior delivery history, including terminal rows', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dedicatedCaptureQueue());
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([dedicatedCaptureLockRow()]);
      // A terminal QUARANTINED/PROCESSED row is still delivery history. The
      // mock returns one only for the fresh-queue count; reverting the query to
      // the old live-work state filter would instead let the poll fetch a body.
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { state?: unknown } }) => Promise.resolve(where.state === undefined ? 1 : 0),
      );
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(prisma.inboundDelivery.count).toHaveBeenCalledWith({ where: { queueId: 1 } });
      expect(client.getMailboxLock).not.toHaveBeenCalled();
      expect(client.fetch).not.toHaveBeenCalled();
      expect(client.fetchOne).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ captureRetiredAt: expect.any(Date) }) }),
      );
    });

    it('capture-only refuses the shared INBOX before an IMAP lock, fetch, ledger row, or cursor write', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ mailbox: '  inbox  ' }),
      );
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(client.getMailboxLock).not.toHaveBeenCalled();
      expect(client.fetch).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(
        (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls.some(
          ([args]) => args?.data?.lastSeenUid !== undefined,
        ),
      ).toBe(false);
    });

    it('capture-only refuses Gmail All Mail before an IMAP lock, fetch, ledger row, or cursor write', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ mailbox: '[Gmail]/All Mail' }),
      );
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(client.getMailboxLock).not.toHaveBeenCalled();
      expect(client.fetch).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(
        (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls.some(
          ([args]) => args?.data?.lastSeenUid !== undefined,
        ),
      ).toBe(false);
    });

    it('counts a truncated capture quarantine against the one-message limit, so a second UID cannot advance', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        // A deliberately tiny private-test threshold drives the bounded IMAP fetch
        // through its truncated/QUARANTINED branch without allocating a huge buffer.
        TELECOM_HD_INBOUND_MAX_SIZE_MB: 0,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
        TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
      });
      const dedicatedQueue = queue({ mailbox: 'Helpdesk Test' });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(dedicatedQueue)
        .mockResolvedValueOnce({ ...dedicatedQueue, lastSeenUid: 101n });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 1,
          emailAddress: 'support@example.com',
          departmentId: null,
          sendAutoresponder: false,
          configGeneration: 0,
          mailbox: 'Helpdesk Test',
        },
      ]);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);
      const source = Buffer.from(
        'From: sender@example.test\r\n\r\nshort but deliberately over tiny test cap',
      );

      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }, { sourceForUid: () => source }),
      );
      await (capture as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        makeLedgerClient([102], { uidValidity: 7n, uidNext: 103 }, { sourceForUid: () => source }),
      );

      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ state: 'QUARANTINED', truncated: true }) }),
      );
      expect(
        (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls.some(
          ([args]) => args?.data?.lastSeenUid === 102n,
        ),
      ).toBe(false);
    });

    it('#10: snapshots the queue department and trusted receiving mailbox onto the delivery at acceptance', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ departmentId: 4 }),
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 1,
          emailAddress: 'support@example.com',
          departmentId: 4,
          sendAutoresponder: false,
          configGeneration: 0,
        },
      ]);
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 1,
          emailAddress: 'support@example.com',
          departmentId: 4,
          routingPriority: 100,
          sendAutoresponder: false,
        },
      ]);
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            departmentId: 4,
            envelopeTo: 'support@example.com',
            routedQueueId: 1,
            routedDepartmentId: 4,
            sendAutoresponder: false,
            routingSnapshot: expect.arrayContaining([
              expect.objectContaining({
                id: 1,
                emailAddress: 'support@example.com',
                departmentId: 4,
                routingPriority: 100,
                sendAutoresponder: false,
              }),
            ]),
          }),
        }),
      );
    });

    it('P1-D: a queue config change after fetch rejects acceptance and leaves the cursor behind the UID', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ departmentId: 4, sendAutoresponder: true, configGeneration: 0 }),
      );
      // The operator moved the queue after fetch. Even if an unsafe direct SQL
      // edit forgot to bump the generation, the locked value comparison rejects it.
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 1,
          emailAddress: 'support@example.com',
          departmentId: 9,
          sendAutoresponder: false,
          configGeneration: 0,
        },
      ]);

      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));

      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 101n } }),
      );
    });

    it('P1-H: reserves large raw MIME against the normal queue fence before writing it', async () => {
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000001.eml';
      const storage = {
        allocateKey: vi.fn().mockReturnValue(storageKey),
        writeFenced: vi
          .fn()
          .mockImplementation(
            async (_source: Buffer, key: string, fence: (publish: () => Promise<void>) => Promise<void>) => {
              await fence(async () => undefined);
              return key;
            },
          ),
        commit: vi.fn().mockResolvedValue(undefined),
        removeFile: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const svc = makeInboundService(
        prisma as unknown as PrismaService,
        TEST_CONFIG,
        storage as unknown as InboundRawStorageService,
      );
      const accept = (
        svc as unknown as {
          acceptImapMessage: (
            q: {
              id: number;
              type: 'IMAP';
              isEnabled: boolean;
              emailAddress: string;
              departmentId: number | null;
              sendAutoresponder: boolean;
              syncState: 'OK';
              mailboxEpoch: number;
              cursorGeneration: number;
              configGeneration: number;
              uidValidity: bigint;
            },
            uv: bigint,
            uid: number,
            source: Buffer,
          ) => Promise<'accepted' | 'duplicate'>;
        }
      ).acceptImapMessage;
      const large = Buffer.alloc(1024 * 1024 + 1, 0x61);
      // Both the short reservation transaction and the final acceptance transaction
      // must prove the normal (not capture-retired) lifecycle predicate. Returning a
      // row only when that exact predicate is present makes this a mutation-resistant
      // fence test rather than a string-only assertion.
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('FROM "InboundRawMimeStaging"')) {
          return Promise.resolve(
            query.sql.includes('SELECT "state"') ? [{ state: 'COMMITTED' }] : [{ storageKey }],
          );
        }
        if (!query.sql?.includes('"captureRetiredAt" IS NULL')) return Promise.resolve([]);
        if (query.sql.includes('SELECT "id", "emailAddress"')) {
          return Promise.resolve([
            {
              id: 1,
              emailAddress: 'support@example.test',
              departmentId: 4,
              sendAutoresponder: false,
              configGeneration: 0,
              mailbox: 'INBOX',
            },
          ]);
        }
        return Promise.resolve([{ id: 1 }]);
      });
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 1,
          emailAddress: 'support@example.test',
          departmentId: 4,
          routingPriority: 100,
          sendAutoresponder: false,
        },
      ]);
      (prisma.inboundDelivery.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      await accept.call(
        svc,
        {
          id: 1,
          type: 'IMAP',
          isEnabled: true,
          emailAddress: 'support@example.test',
          departmentId: 4,
          sendAutoresponder: false,
          syncState: 'OK',
          mailboxEpoch: 1,
          cursorGeneration: 0,
          configGeneration: 0,
          uidValidity: 7n,
        },
        7n,
        101,
        large,
      );
      expect(prisma.inboundRawMimeStaging.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storageKey,
            queueId: 1,
            state: 'ACTIVE',
            leaseExpiresAt: expect.any(Date),
          }),
        }),
      );
      expect(storage.writeFenced).toHaveBeenCalledWith(large, storageKey, expect.any(Function));
      expect(
        (prisma.inboundRawMimeStaging.create as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
      ).toBeLessThan(storage.writeFenced.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
      expect(prisma.inboundRawMimeStaging.deleteMany).toHaveBeenCalledWith({
        where: { storageKey, state: 'COMMITTED' },
      });
      expect(storage.commit).toHaveBeenCalledWith(storageKey);
      const reservationQuery = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls
        .map(([query]) => query as { sql?: string })
        .find((query) => query.sql?.includes('SELECT "id"\n        FROM "EmailQueue"'));
      expect(reservationQuery?.sql).toContain('"captureRetiredAt" IS NULL');
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            rawMime: null,
            rawStorageKey: expect.stringMatching(/^inbound-raw\//),
          }),
        }),
      );
    });

    it('P0 raw-stage fence: acceptance retains the stage through ledger commit, then commits marker before finalization', async () => {
      // This is the torn-snapshot regression barrier. If acceptance deletes the durable
      // stage inside the same transaction as InboundDelivery, a reaper using separate
      // READ COMMITTED statements can observe neither row and delete the raw file just
      // before the delivery becomes visible. The stage must instead remain/lock through
      // the ledger commit, then be finalized only after the pending marker is committed.
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000012.eml';
      const events: string[] = [];
      const storage = {
        allocateKey: vi.fn().mockReturnValue(storageKey),
        writeFenced: vi
          .fn()
          .mockImplementation(
            async (_source: Buffer, key: string, fence: (publish: () => Promise<void>) => Promise<void>) => {
              events.push('write');
              await fence(async () => {
                events.push('publish');
              });
              return key;
            },
          ),
        commit: vi.fn().mockImplementation(async () => {
          events.push('marker');
        }),
        removeFile: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const svc = makeInboundService(
        prisma as unknown as PrismaService,
        TEST_CONFIG,
        storage as unknown as InboundRawStorageService,
      );
      let transactionNumber = 0;
      let activeTransaction = 0;
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(async (input: unknown) => {
        if (typeof input !== 'function') return Promise.all(input as Promise<unknown>[]);
        const transaction = ++transactionNumber;
        activeTransaction = transaction;
        try {
          const result = await (input as (tx: typeof prisma) => Promise<unknown>)(prisma);
          events.push(`commit:${transaction}`);
          return result;
        } finally {
          activeTransaction = 0;
        }
      });
      (prisma.inboundRawMimeStaging.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        events.push('stage-create');
        return {};
      });
      (prisma.inboundRawMimeStaging.deleteMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        events.push('stage-delete');
        return { count: 1 };
      });
      (prisma.inboundRawMimeStaging.updateMany as ReturnType<typeof vi.fn>).mockImplementation(
        async ({ data }: { data: { state?: string } }) => {
          if (data.state === 'COMMITTED') {
            events.push(`stage-committed:tx${activeTransaction}`);
          }
          return { count: 1 };
        },
      );
      Object.assign(prisma.inboundRawMimeStaging as object, {
        findUnique: vi.fn().mockResolvedValue({ storageKey }),
        findFirst: vi.fn().mockResolvedValue({ storageKey }),
      });
      (prisma.inboundDelivery.createMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        events.push('ledger');
        return { count: 1 };
      });
      (prisma.inboundDelivery.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('FROM "InboundRawMimeStaging"')) {
          return Promise.resolve(
            query.sql.includes('SELECT "state"') ? [{ state: 'COMMITTED' }] : [{ storageKey }],
          );
        }
        if (query.sql?.includes('SELECT "id", "emailAddress"')) {
          return Promise.resolve([
            {
              id: 1,
              emailAddress: 'support@example.test',
              departmentId: 4,
              sendAutoresponder: false,
              configGeneration: 0,
              mailbox: 'INBOX',
            },
          ]);
        }
        return Promise.resolve([{ id: 1 }]);
      });
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 1,
          emailAddress: 'support@example.test',
          departmentId: 4,
          routingPriority: 100,
          sendAutoresponder: false,
        },
      ]);
      const accept = (
        svc as unknown as {
          acceptImapMessage: (
            q: Record<string, unknown>,
            uidValidity: bigint,
            uid: number,
            source: Buffer,
          ) => Promise<'accepted' | 'duplicate'>;
        }
      ).acceptImapMessage;

      await expect(
        accept.call(
          svc,
          {
            id: 1,
            type: 'IMAP',
            isEnabled: true,
            emailAddress: 'support@example.test',
            departmentId: 4,
            sendAutoresponder: false,
            syncState: 'OK',
            mailbox: 'INBOX',
            mailboxEpoch: 1,
            cursorGeneration: 0,
            configGeneration: 0,
            uidValidity: 7n,
            captureRetiredAt: null,
          },
          7n,
          101,
          Buffer.alloc(1024 * 1024 + 1, 0x61),
        ),
      ).resolves.toBe('accepted');

      const ledger = events.indexOf('ledger');
      const stageCommitted = events.indexOf('stage-committed:tx3');
      const acceptedCommit = events.indexOf('commit:3');
      const marker = events.indexOf('marker');
      const stageDelete = events.indexOf('stage-delete');
      expect(ledger).toBeGreaterThan(-1);
      expect(stageCommitted).toBeGreaterThan(ledger);
      expect(stageCommitted).toBeLessThan(acceptedCommit);
      expect(acceptedCommit).toBeGreaterThan(ledger);
      expect(marker).toBeGreaterThan(acceptedCommit);
      expect(stageDelete).toBeGreaterThan(marker);
      expect(prisma.inboundRawMimeStaging.updateMany).toHaveBeenCalledWith({
        where: { storageKey, state: 'ACTIVE' },
        data: { state: 'COMMITTED' },
      });
    });

    it('P0 capture-retirement fence: a capture reservation requires the retired queue marker', async () => {
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000006.eml';
      const storage = {
        allocateKey: vi.fn().mockReturnValue(storageKey),
        writeFenced: vi
          .fn()
          .mockImplementation(
            async (_source: Buffer, key: string, fence: (publish: () => Promise<void>) => Promise<void>) => {
              await fence(async () => undefined);
              return key;
            },
          ),
        removeFile: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
      };
      const capture = makeInboundService(
        prisma as unknown as PrismaService,
        {
          ...TEST_CONFIG,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
        },
        storage as unknown as InboundRawStorageService,
      );
      // The simulated database grants the reservation only to the exact capture
      // lifecycle predicate. Changing it to IS NULL (or removing it) makes the
      // write fail before any bytes are staged.
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('FROM "InboundRawMimeStaging"')) {
          return Promise.resolve([{ storageKey }]);
        }
        return Promise.resolve(query.sql?.includes('"captureRetiredAt" IS NOT NULL') ? [{ id: 1 }] : []);
      });
      const persist = (
        capture as unknown as {
          persistRawMime: (
            source: Buffer,
            queueId: number,
            capture: boolean,
          ) => Promise<{
            rawStorageKey: string | null;
          }>;
        }
      ).persistRawMime;
      const discard = (capture as unknown as { discardRawStage: (key: string | null) => Promise<void> })
        .discardRawStage;

      const raw = await persist.call(capture, Buffer.alloc(1024 * 1024 + 1, 0x61), 1, true);

      expect(prisma.inboundRawMimeStaging.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ storageKey, queueId: 1, leaseExpiresAt: expect.any(Date) }),
        }),
      );
      expect(storage.writeFenced).toHaveBeenCalledWith(expect.any(Buffer), storageKey, expect.any(Function));
      const [reservationQuery] = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls;
      expect((reservationQuery?.[0] as { sql?: string } | undefined)?.sql).toContain(
        '"captureRetiredAt" IS NOT NULL',
      );

      await discard.call(capture, raw.rawStorageKey);
    });

    it('P0 raw-stage fence: a stale writer cannot publish after a reaper has taken the stage', async () => {
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000014.eml';
      let state: 'ACTIVE' | 'REAPING' = 'ACTIVE';
      const publish = vi.fn().mockResolvedValue(undefined);
      const storage = {
        allocateKey: vi.fn().mockReturnValue(storageKey),
        writeFenced: vi
          .fn()
          .mockImplementation(
            async (_source: Buffer, key: string, fence: (publish: () => Promise<void>) => Promise<void>) => {
              // The private temporary write completed, then the reaper atomically claimed the
              // durable stage. The writer must never receive a usable rename capability after it.
              state = 'REAPING';
              await fence(publish);
              return key;
            },
          ),
        removeFile: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
      };
      const svc = makeInboundService(
        prisma as unknown as PrismaService,
        TEST_CONFIG,
        storage as unknown as InboundRawStorageService,
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('FROM "InboundRawMimeStaging"')) {
          return Promise.resolve(state === 'ACTIVE' ? [{ storageKey }] : []);
        }
        return Promise.resolve(query.sql?.includes('"captureRetiredAt" IS NULL') ? [{ id: 1 }] : []);
      });
      const persist = (
        svc as unknown as {
          persistRawMime: (source: Buffer, queueId: number, capture: boolean) => Promise<unknown>;
        }
      ).persistRawMime;

      await expect(persist.call(svc, Buffer.alloc(1024 * 1024 + 1, 0x61), 1, false)).rejects.toThrow(
        /writer lost its staging fence before publish/i,
      );

      expect(storage.writeFenced).toHaveBeenCalledWith(expect.any(Buffer), storageKey, expect.any(Function));
      expect(publish).not.toHaveBeenCalled();
      expect(storage.removeFile).not.toHaveBeenCalled();
      expect(storage.commit).not.toHaveBeenCalled();
    });

    it('P0 capture-retirement fence: failed raw-file cleanup retains the reservation and blocks capture arming', async () => {
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000007.eml';
      let stagePresent = false;
      const storage = {
        allocateKey: vi.fn().mockReturnValue(storageKey),
        writeFenced: vi
          .fn()
          .mockImplementation(
            async (_source: Buffer, key: string, fence: (publish: () => Promise<void>) => Promise<void>) => {
              await fence(async () => undefined);
              return key;
            },
          ),
        removeFile: vi.fn().mockRejectedValue(new Error('filesystem still has raw bytes')),
        commit: vi.fn().mockResolvedValue(undefined),
      };
      (prisma.inboundRawMimeStaging.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
        stagePresent = true;
        return Promise.resolve({});
      });
      (prisma.inboundRawMimeStaging.deleteMany as ReturnType<typeof vi.fn>).mockImplementation(() => {
        stagePresent = false;
        return Promise.resolve({ count: 1 });
      });
      (prisma.inboundRawMimeStaging.count as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(stagePresent ? 1 : 0),
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('SELECT "id", "captureRetiredAt"')) {
          return Promise.resolve([{ id: 1, captureRetiredAt: null }]);
        }
        return Promise.resolve([{ id: 1 }]);
      });
      const capture = makeInboundService(
        prisma as unknown as PrismaService,
        {
          ...TEST_CONFIG,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
        },
        storage as unknown as InboundRawStorageService,
      );
      const persist = (
        capture as unknown as {
          persistRawMime: (
            source: Buffer,
            queueId: number,
            capture: boolean,
          ) => Promise<{
            rawStorageKey: string | null;
          }>;
        }
      ).persistRawMime;
      const discard = (capture as unknown as { discardRawStage: (key: string | null) => Promise<void> })
        .discardRawStage;
      const arm = (
        capture as unknown as {
          armCaptureQueue: (snapshot: Record<string, unknown>, mailbox: string) => Promise<boolean>;
        }
      ).armCaptureQueue;

      const raw = await persist.call(capture, Buffer.alloc(1024 * 1024 + 1, 0x61), 1, false);
      await discard.call(capture, raw.rawStorageKey);

      expect(storage.removeFile).toHaveBeenCalledWith(storageKey);
      expect(prisma.inboundRawMimeStaging.deleteMany).not.toHaveBeenCalled();
      expect(storage.commit).not.toHaveBeenCalled();
      expect(stagePresent).toBe(true);
      await expect(arm.call(capture, dedicatedCaptureQueue(), 'Helpdesk Test')).rejects.toThrow(
        /pending raw MIME staging/i,
      );
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('P1-H: an expired DB-only reservation is reaped even without a pending marker and unblocks capture arming', async () => {
      // Crash point: the short reservation transaction committed, then the process died
      // before rawStorage.writeFenced() could create its on-disk pending marker. A marker-only
      // sweep would never discover this row, permanently preventing a fresh capture arm.
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000011.eml';
      let stagePresent = true;
      let expired = false;
      const storage = {
        listPending: vi.fn().mockResolvedValue([]),
        removeFile: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      (prisma.inboundRawMimeStaging.findMany as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(
          stagePresent && expired
            ? [{ storageKey, state: 'ACTIVE', leaseExpiresAt: new Date(Date.now() - 60_000) }]
            : [],
        ),
      );
      (prisma.inboundRawMimeStaging.count as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(stagePresent ? 1 : 0),
      );
      (prisma.inboundRawMimeStaging.deleteMany as ReturnType<typeof vi.fn>).mockImplementation(() => {
        stagePresent = false;
        return Promise.resolve({ count: 1 });
      });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('SELECT "id", "captureRetiredAt"')) {
          return Promise.resolve([{ id: 1, captureRetiredAt: null }]);
        }
        if (query.sql?.includes('FROM "InboundRawMimeStaging"')) {
          return Promise.resolve(
            query.sql.includes('SELECT "state"') ? [{ state: 'REAPING' }] : [{ storageKey }],
          );
        }
        return Promise.resolve([{ id: 1 }]);
      });
      const capture = makeInboundService(
        prisma as unknown as PrismaService,
        {
          ...TEST_CONFIG,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
        },
        storage,
      );
      const arm = (
        capture as unknown as {
          armCaptureQueue: (snapshot: Record<string, unknown>, mailbox: string) => Promise<boolean>;
        }
      ).armCaptureQueue;
      const cleanup = (capture as unknown as { cleanupUncommittedRawStorage: () => Promise<void> })
        .cleanupUncommittedRawStorage;

      await expect(arm.call(capture, dedicatedCaptureQueue(), 'Helpdesk Test')).rejects.toThrow(
        /pending raw MIME staging/i,
      );
      expired = true;
      await cleanup.call(capture);

      expect(prisma.inboundRawMimeStaging.deleteMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ storageKey }) }),
      );
      expect(stagePresent).toBe(false);
      await expect(arm.call(capture, dedicatedCaptureQueue(), 'Helpdesk Test')).resolves.toBe(true);
    });

    it('P1-H: bounded marker cleanup retains referenced bytes and reaps only an unreferenced legacy orphan', async () => {
      const referenced = 'inbound-raw/00000000-0000-4000-8000-000000000001.eml';
      const orphan = 'inbound-raw/00000000-0000-4000-8000-000000000002.eml';
      const storage = {
        listPending: vi.fn().mockResolvedValue([referenced, orphan]),
        commit: vi.fn().mockResolvedValue(undefined),
        removeFile: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      (prisma.inboundRawMimeStaging.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundDelivery.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { rawStorageKey: string } }) =>
          Promise.resolve(where.rawStorageKey === referenced ? { id: 1 } : null),
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await (
        svc as unknown as { cleanupUncommittedRawStorage: () => Promise<void> }
      ).cleanupUncommittedRawStorage();

      expect(storage.listPending).toHaveBeenCalledWith(100, expect.any(Date));
      expect(storage.commit).toHaveBeenCalledWith(referenced);
      expect(storage.removeFile).toHaveBeenCalledWith(orphan);
      expect(storage.removeFile).not.toHaveBeenCalledWith(referenced);
      expect(storage.commit).toHaveBeenCalledWith(orphan);
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('P1-H: staged raw MIME is never reaped while its acceptance lease is still live', async () => {
      const staged = 'inbound-raw/00000000-0000-4000-8000-000000000003.eml';
      const storage = {
        listPending: vi.fn().mockResolvedValue([staged]),
        commit: vi.fn().mockResolvedValue(undefined),
        removeFile: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundRawMimeStaging.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { storageKey: staged, state: 'ACTIVE', leaseExpiresAt: new Date(Date.now() + 60_000) },
      ]);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) =>
        Promise.resolve(query.sql?.includes('SELECT "state"') ? [{ state: 'ACTIVE' }] : []),
      );

      await (
        svc as unknown as { cleanupUncommittedRawStorage: () => Promise<void> }
      ).cleanupUncommittedRawStorage();

      expect(prisma.inboundRawMimeStaging.deleteMany).not.toHaveBeenCalled();
      expect(storage.removeFile).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(storage.commit).not.toHaveBeenCalled();
    });

    it('P1-H: an expired stage locked by acceptance is skipped instead of deleting its raw file', async () => {
      const staged = 'inbound-raw/00000000-0000-4000-8000-000000000004.eml';
      const storage = {
        listPending: vi.fn().mockResolvedValue([staged]),
        commit: vi.fn().mockResolvedValue(undefined),
        removeFile: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundRawMimeStaging.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { storageKey: staged, state: 'ACTIVE', leaseExpiresAt: new Date(Date.now() - 60_000) },
      ]);
      // SELECT … FOR UPDATE SKIP LOCKED returns no row while acceptance owns the stage.
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundRawMimeStaging.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        storageKey: staged,
      });

      await (
        svc as unknown as { cleanupUncommittedRawStorage: () => Promise<void> }
      ).cleanupUncommittedRawStorage();

      expect(prisma.inboundRawMimeStaging.deleteMany).not.toHaveBeenCalled();
      expect(storage.removeFile).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(storage.commit).not.toHaveBeenCalled();
    });

    it('P0 raw-stage fence: reaper rechecks the ledger pointer under the stage lock, never a torn precheck', async () => {
      const staged = 'inbound-raw/00000000-0000-4000-8000-000000000013.eml';
      const storage = {
        listPending: vi.fn().mockResolvedValue([staged]),
        removeFile: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      // A separate delivery precheck is exactly the torn READ COMMITTED window that used
      // to make deletion unsafe. The durable stage remains visible/locked while acceptance
      // commits, so the reaper must inspect the pointer only after obtaining that lock.
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('must not use a separate stale delivery precheck'),
      );
      (prisma.inboundDelivery.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 55 });
      (prisma.inboundRawMimeStaging.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { storageKey: staged, state: 'COMMITTED', leaseExpiresAt: new Date(Date.now() - 60_000) },
      ]);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) =>
        Promise.resolve(query.sql?.includes('SELECT "state"') ? [{ state: 'COMMITTED' }] : []),
      );

      await (
        svc as unknown as { cleanupUncommittedRawStorage: () => Promise<void> }
      ).cleanupUncommittedRawStorage();

      expect(prisma.inboundDelivery.findFirst).toHaveBeenCalledWith({
        where: { rawStorageKey: staged },
        select: { id: true },
      });
      expect(storage.removeFile).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.inboundRawMimeStaging.deleteMany).toHaveBeenCalledWith({
        where: { storageKey: staged, state: 'COMMITTED' },
      });
      expect(storage.commit).toHaveBeenCalledWith(staged);
    });

    it('P1-H: an expired-stage file-removal failure retains both reservation and pending marker', async () => {
      const staged = 'inbound-raw/00000000-0000-4000-8000-000000000008.eml';
      const storage = {
        listPending: vi.fn().mockResolvedValue([staged]),
        removeFile: vi.fn().mockRejectedValue(new Error('filesystem unavailable')),
        commit: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundRawMimeStaging.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { storageKey: staged, state: 'ACTIVE', leaseExpiresAt: new Date(Date.now() - 60_000) },
      ]);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) =>
        Promise.resolve(
          query.sql?.includes('SELECT "state"') ? [{ state: 'REAPING' }] : [{ storageKey: staged }],
        ),
      );

      await (
        svc as unknown as { cleanupUncommittedRawStorage: () => Promise<void> }
      ).cleanupUncommittedRawStorage();

      expect(storage.removeFile).toHaveBeenCalledWith(staged);
      expect(prisma.inboundRawMimeStaging.deleteMany).not.toHaveBeenCalled();
      expect(prisma.inboundRawMimeStaging.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { state: 'REAPING' } }),
      );
      // `commit` deletes the pending marker and `remove` deletes both marker/file. Neither
      // is safe after file removal failed, so the next bounded reaper pass retains evidence.
      expect(storage.commit).not.toHaveBeenCalled();
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('P0 raw-stage fence: unlink success plus DB-finalization failure leaves REAPING and blocks acceptance', async () => {
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000015.eml';
      let state: 'ACTIVE' | 'REAPING' = 'ACTIVE';
      const storage = {
        removeFile: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (!query.sql?.includes('FROM "InboundRawMimeStaging"')) return Promise.resolve([]);
        return Promise.resolve(state === 'ACTIVE' ? [{ storageKey }] : []);
      });
      (prisma.inboundRawMimeStaging.updateMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({
          where,
          data,
        }: {
          where: { storageKey: string; state: 'ACTIVE' | 'REAPING' };
          data: { state: 'ACTIVE' | 'REAPING' };
        }) => {
          if (where.storageKey !== storageKey || where.state !== state) {
            return Promise.resolve({ count: 0 });
          }
          state = data.state;
          return Promise.resolve({ count: 1 });
        },
      );
      // Simulate a database failure after bytes were removed: the state row must remain
      // REAPING, so a later acceptance cannot manufacture a ledger pointer to missing bytes.
      (prisma.inboundRawMimeStaging.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      const discard = (svc as unknown as { discardRawStage: (key: string | null) => Promise<void> })
        .discardRawStage;
      const lock = (
        svc as unknown as {
          lockRawStageForAcceptance: (tx: unknown, key: string | null) => Promise<void>;
        }
      ).lockRawStageForAcceptance;

      await discard.call(svc, storageKey);

      expect(storage.removeFile).toHaveBeenCalledWith(storageKey);
      expect(prisma.inboundRawMimeStaging.deleteMany).toHaveBeenCalledWith({
        where: { storageKey, state: 'REAPING' },
      });
      expect(state).toBe('REAPING');
      expect(storage.commit).not.toHaveBeenCalled();
      await expect(lock.call(svc, prisma, storageKey)).rejects.toThrow(
        /staging fence is unavailable before acceptance/i,
      );
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
    });

    it('P1-H: expired-stage cleanup is file -> durable stage delete -> pending-marker commit', async () => {
      const staged = 'inbound-raw/00000000-0000-4000-8000-000000000009.eml';
      const operations: string[] = [];
      const storage = {
        listPending: vi.fn().mockResolvedValue([staged]),
        removeFile: vi.fn().mockImplementation(async () => {
          operations.push('file');
        }),
        commit: vi.fn().mockImplementation(async () => {
          operations.push('marker');
        }),
        remove: vi.fn().mockImplementation(async () => {
          operations.push('remove');
        }),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundRawMimeStaging.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { storageKey: staged, state: 'ACTIVE', leaseExpiresAt: new Date(Date.now() - 60_000) },
      ]);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) =>
        Promise.resolve(
          query.sql?.includes('SELECT "state"') ? [{ state: 'REAPING' }] : [{ storageKey: staged }],
        ),
      );
      (prisma.inboundRawMimeStaging.deleteMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        operations.push('stage');
        return { count: 1 };
      });

      await (
        svc as unknown as { cleanupUncommittedRawStorage: () => Promise<void> }
      ).cleanupUncommittedRawStorage();

      expect(operations).toEqual(['file', 'stage', 'marker']);
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('P1-H: a missing staging fence rejects acceptance before a delivery can be inserted', async () => {
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000005.eml';
      const storage = {
        allocateKey: vi.fn().mockReturnValue(storageKey),
        writeFenced: vi
          .fn()
          .mockImplementation(
            async (_source: Buffer, key: string, fence: (publish: () => Promise<void>) => Promise<void>) => {
              await fence(async () => undefined);
              return key;
            },
          ),
        commit: vi.fn().mockResolvedValue(undefined),
        removeFile: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      } as unknown as InboundRawStorageService;
      const svc = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, storage);
      (prisma.inboundRawMimeStaging.deleteMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      const accept = (
        svc as unknown as {
          acceptImapMessage: (
            q: {
              id: number;
              type: 'IMAP';
              isEnabled: boolean;
              emailAddress: string;
              departmentId: number | null;
              sendAutoresponder: boolean;
              syncState: 'OK';
              mailboxEpoch: number;
              cursorGeneration: number;
              configGeneration: number;
              uidValidity: bigint;
            },
            uv: bigint,
            uid: number,
            source: Buffer,
          ) => Promise<'accepted' | 'duplicate'>;
        }
      ).acceptImapMessage;
      let activeStageLocks = 0;
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('FROM "InboundRawMimeStaging"')) {
          activeStageLocks += 1;
          return Promise.resolve(activeStageLocks === 1 ? [{ storageKey }] : []);
        }
        if (!query.sql?.includes('"captureRetiredAt" IS NULL')) return Promise.resolve([]);
        if (query.sql.includes('SELECT "id", "emailAddress"')) {
          return Promise.resolve([
            {
              id: 1,
              emailAddress: 'support@example.test',
              departmentId: null,
              sendAutoresponder: false,
              configGeneration: 0,
              mailbox: 'INBOX',
            },
          ]);
        }
        return Promise.resolve([{ id: 1 }]);
      });
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        {
          id: 1,
          emailAddress: 'support@example.test',
          departmentId: null,
          routingPriority: 100,
          sendAutoresponder: false,
        },
      ]);

      await expect(
        accept.call(
          svc,
          {
            id: 1,
            type: 'IMAP',
            isEnabled: true,
            emailAddress: 'support@example.test',
            departmentId: null,
            sendAutoresponder: false,
            syncState: 'OK',
            mailboxEpoch: 1,
            cursorGeneration: 0,
            configGeneration: 0,
            uidValidity: 7n,
          },
          7n,
          101,
          Buffer.alloc(1024 * 1024 + 1, 0x61),
        ),
      ).rejects.toThrow(/staging fence is unavailable/i);
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      // The reservation cannot be locked as ACTIVE, so cleanup must retain it rather than
      // unlinking bytes that another transaction may still own.
      expect(storage.removeFile).not.toHaveBeenCalled();
    });

    it('processes out-of-order UIDs and advances the cursor to the max (no loss)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      await poll(makeLedgerClient([103, 101], { uidValidity: 7n, uidNext: 104 }));
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledTimes(2);
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 103n } }),
      );
    });

    it('fail-closed: a fetch error stops the poll WITHOUT advancing the cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      await poll(makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 }, { fetchOneThrowsAt: 101 }));
      // 101 failed before acceptance → nothing accepted, cursor NOT advanced. (A liveness
      // stamp updateMany may run — assert specifically that no cursor-advancing write happened.)
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastSeenUid: 101n }) }),
      );

      // A new generation only starts accepting after its own reconcile baseline.  Once that
      // baseline is durable, the same UID is a new epoch transport identity and is accepted
      // by the new poller — the stale poller's rejected fetch did not consume it.
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ mailboxEpoch: 2, cursorGeneration: 1, lastSeenUid: 100n, uidValidity: 7n }),
      );
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ transportKey: 'imap:1:2:7:101' }) }),
      );
    });

    it('fail-closed: a ledger DB error during accept does NOT advance the cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      (prisma.inboundDelivery.createMany as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('db down'),
      );
      await poll(makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 }));
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastSeenUid: expect.anything() }) }),
      );
    });

    it('idempotent: an exact duplicate transport identity is a no-op and the cursor still advances', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      (prisma.inboundDelivery.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        queueId: 1,
        mailboxEpoch: 1,
        uidValidity: 7n,
        uid: 101n,
        contentHash: createHash('sha256').update(imapSrc(101)).digest('hex'),
      });
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 101n } }),
      );
    });

    it('an EXPUNGE-vanished UID is skipped and the cursor advances past it (no wedge)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      await poll(makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 }, { vanish: [101] }));
      // 101 vanished (no create), 102 accepted; cursor reaches 102.
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 102n } }),
      );
    });

    it('does not report a vanished UID as an accepted message', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }, { vanish: [101] }));

      const livenessWrites = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls.map(
        ([input]) => (input as { data?: Record<string, unknown> }).data ?? {},
      );
      expect(livenessWrites).toContainEqual(expect.objectContaining({ lastPollAt: expect.any(Date) }));
      expect(livenessWrites.some((data) => 'lastAcceptedAt' in data)).toBe(false);
    });

    it('P0-3: a UIDVALIDITY change HALTS the queue (NEEDS_RECONCILIATION), accepts nothing', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ uidValidity: 7n }),
      );
      await poll(makeLedgerClient([1, 2], { uidValidity: 9n, uidNext: 50 }));
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      // The halt is a generation-gated updateMany (so a stale poll can't clobber a
      // freshly-reconciled OK state), not an unconditional update.
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 1, uidValidity: 7n }),
          data: expect.objectContaining({ syncState: 'NEEDS_RECONCILIATION' }),
        }),
      );
    });

    it('a halted queue (NEEDS_RECONCILIATION) does not fetch or accept', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ syncState: 'NEEDS_RECONCILIATION' }),
      );
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });
      await poll(client);
      expect(client.getMailboxLock).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
    });

    it('P1-D barrier: stale poller is fenced after fetch and before ledger insert', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      let releaseFence: ((rows: Array<{ id: number }>) => void) | undefined;
      const fenceEntered = new Promise<void>((resolve) => {
        (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementationOnce(
          () =>
            new Promise<Array<{ id: number }>>((release) => {
              releaseFence = release;
              resolve();
            }),
        );
      });
      const client = makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 });
      const running = poll(client);
      await fenceEntered;

      // Model the concurrent identity/reconcile transition. Its CAS bumps epoch/generation;
      // the SELECT ... FOR UPDATE fence rechecks the old snapshot after it commits and finds
      // no matching row. Releasing an old fetch must therefore NOT create a delivery.
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      const queues = await import('./email-queue.service');
      const queueService = new queues.EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        undefined,
        undefined,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      await queueService.update(1, { host: 'new-imap.example', expectedConfigGeneration: 0 });
      releaseFence?.([]);
      await running;

      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mailboxEpoch: { increment: 1 },
            cursorGeneration: { increment: 1 },
          }),
        }),
      );
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastSeenUid: 101n }) }),
      );
    });

    it('P1-D out-of-order discovery is accepted in ascending UID order; lower failure is never skipped', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      const client = makeLedgerClient(
        [103, 101],
        { uidValidity: 7n, uidNext: 104 },
        { fetchOneThrowsAt: 101 },
      );
      await poll(client);

      // A server returned 103 first, but we must fetch lower UID 101 before it; the failure
      // leaves the cursor at 100 and 103 is retried only after 101 is durably accepted.
      expect(client.fetchOne).toHaveBeenCalledTimes(1);
      expect(client.fetchOne).toHaveBeenCalledWith('101', expect.anything(), { uid: true });
      expect(prisma.inboundDelivery.createMany).not.toHaveBeenCalled();
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastSeenUid: expect.anything() }) }),
      );
    });

    it('P1-D out-of-order: sorted acceptance advances only through the contiguous successful prefix', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      // The server yielded 102, then a failing 103, and only then 101. Sorting means the
      // contiguous prefix 101,102 is accepted before 103 fails, so cursor=102 is safe.
      const client = makeLedgerClient(
        [102, 103, 101],
        { uidValidity: 7n, uidNext: 104 },
        { fetchOneThrowsAt: 103 },
      );
      await poll(client);

      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ uid: 101n }) }),
      );
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ uid: 102n }) }),
      );
      expect(client.fetchOne.mock.calls.map(([uid]) => uid)).toEqual(['101', '102', '103']);
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 102n } }),
      );
    });

    it('P0-A collision: same epoch/UID with different bytes halts + audits and never advances cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      (prisma.inboundDelivery.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        queueId: 1,
        mailboxEpoch: 1,
        uidValidity: 7n,
        uid: 101n,
        contentHash: 'different-hash',
      });
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));

      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            syncState: 'NEEDS_RECONCILIATION',
            reconcileCause: 'TRANSPORT_COLLISION',
          }),
        }),
      );
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'mail.transport_collision' }) }),
      );
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastSeenUid: 101n }) }),
      );
    });

    it('P0-A accepts reused UIDVALIDITY/UID in a new mailbox epoch as a new transport delivery', async () => {
      const findQueue = prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>;
      findQueue
        .mockResolvedValueOnce(queue({ mailboxEpoch: 1 }))
        .mockResolvedValueOnce(queue({ mailboxEpoch: 2 }));
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));
      const keys = (prisma.inboundDelivery.createMany as ReturnType<typeof vi.fn>).mock.calls.map(
        ([arg]) => (arg as { data: { transportKey: string } }).data.transportKey,
      );
      expect(keys).toEqual(['imap:1:1:7:101', 'imap:1:2:7:101']);
    });
  });

  describe('captureReconcileBaseline — exact synchronous P0-B boundary', () => {
    const snapshot = {
      id: 1,
      host: 'imap.example',
      port: 993,
      username: 'support',
      passwordEnc: '',
      useTls: true,
      mailbox: 'Helpdesk/Test',
      mailboxEpoch: 2,
      cursorGeneration: 5,
      configGeneration: 0,
    };

    function attachLiveClientTo(
      target: InboundMailService,
      client: unknown,
      targetSnapshot: typeof snapshot = snapshot,
    ) {
      const internals = target as unknown as {
        connections: Map<number, unknown>;
        connectionFingerprints: Map<number, string>;
        connectionFingerprint: (queue: typeof snapshot) => string;
      };
      internals.connections.set(1, client);
      internals.connectionFingerprints.set(1, internals.connectionFingerprint(targetSnapshot));
    }

    function attachLiveClient(client: unknown) {
      attachLiveClientTo(service, client);
    }

    it('FROM_NOW persists UIDNEXT-1 exactly; it never substitutes EXISTS or a wildcard fallback', async () => {
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 101, exists: 4 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn(),
      };
      attachLiveClient(client);
      await expect(service.captureReconcileBaseline(snapshot, 'FROM_NOW', 0)).resolves.toEqual({
        uidValidity: 7n,
        boundary: 100,
        cursor: 100,
        selectedUids: [],
      });
      expect(client.getMailboxLock).toHaveBeenCalledWith('Helpdesk/Test');
      expect(client.search).not.toHaveBeenCalled();
    });

    it('P0-B barrier: a UID delivered after the captured FROM_NOW boundary is accepted by the next poll', async () => {
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 101, exists: 100 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn(),
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: vi.fn(function* () {
          yield { uid: 101 };
        }),
        fetchOne: vi.fn().mockResolvedValue({
          uid: 101,
          source: Buffer.from('From: sender@example.com\r\n\r\narrived after boundary'),
        }),
      };
      attachLiveClient(client);

      const baseline = await service.captureReconcileBaseline(snapshot, 'FROM_NOW', 0);
      expect(baseline).toMatchObject({ boundary: 100, cursor: 100 });

      // Simulate APPEND after UIDNEXT was snapshotted, but before the next poll starts.
      // The committed boundary stays 100, therefore UID 101 must be fetched rather than
      // folded into the discarded history.
      client.mailbox.uidNext = 102;
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        emailAddress: 'support@example.com',
        departmentId: null,
        sendAutoresponder: false,
        lastSeenUid: 100n,
        uidValidity: 7n,
        syncState: 'OK',
        lastError: null,
        cursorGeneration: 5,
        mailboxEpoch: 2,
        configGeneration: 0,
        reconcileCause: null,
      });
      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(client.fetch).toHaveBeenCalledWith('101:*', expect.anything(), { uid: true });
      expect(prisma.inboundDelivery.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ uid: 101n, transportKey: 'imap:1:2:7:101' }),
        }),
      );
    });

    it('BACKFILL chooses the last N existing sparse UIDs below the SAME UIDNEXT boundary', async () => {
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 101, exists: 5 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        // 101 arrived after the snapshot; it must not be included in the discarded/backfill set.
        search: vi.fn().mockResolvedValue([2, 90, 95, 100, 101]),
      };
      attachLiveClient(client);
      await expect(service.captureReconcileBaseline(snapshot, 'BACKFILL', 2)).resolves.toEqual({
        uidValidity: 7n,
        boundary: 100,
        cursor: 94,
        selectedUids: [95, 100],
      });
      expect(client.search).toHaveBeenCalledWith({ uid: '1:100' }, { uid: true });
    });

    it('fails closed when UIDNEXT is absent instead of falling back to 1:*', async () => {
      const client = {
        mailbox: { uidValidity: 7n, exists: 99 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn(),
      };
      attachLiveClient(client);
      await expect(service.captureReconcileBaseline(snapshot, 'FROM_NOW', 0)).rejects.toThrow(
        /UIDVALIDITY\/UIDNEXT/i,
      );
      expect(client.search).not.toHaveBeenCalled();
    });

    it('capture-only rejects a direct reconcile probe for any nonselected queue before IMAP access', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      const otherQueue = { ...snapshot, id: 2, mailbox: 'Operations' };

      await expect(capture.captureReconcileBaseline(otherQueue, 'FROM_NOW', 0)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect((capture as unknown as { connections: Map<number, unknown> }).connections.size).toBe(0);
    });

    it('capture-only refuses a provider special-use folder after LIST and drops the reused authenticated socket', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 1, exists: 0 },
        list: vi.fn().mockResolvedValue([
          {
            path: 'Helpdesk/Test',
            pathAsListed: 'Helpdesk/Test',
            listed: true,
            flags: new Set(),
            specialUse: '\\Archive',
          },
        ]),
        getMailboxLock: vi.fn(),
        logout: vi.fn().mockResolvedValue(undefined),
      };
      attachLiveClientTo(capture, client);

      await expect(capture.captureReconcileBaseline(snapshot, 'FROM_NOW', 0)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(client.getMailboxLock).not.toHaveBeenCalled();
      expect(client.logout).toHaveBeenCalledTimes(1);
      expect((capture as unknown as { connections: Map<number, unknown> }).connections.has(1)).toBe(false);
    });

    it('capture-only refuses a nonempty dedicated folder before it chooses a FROM_NOW baseline', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      const release = vi.fn();
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 2, exists: 1 },
        list: vi.fn().mockResolvedValue([
          {
            path: 'Helpdesk/Test',
            pathAsListed: 'Helpdesk/Test',
            listed: true,
            flags: new Set(),
          },
        ]),
        getMailboxLock: vi.fn().mockResolvedValue({ release }),
        logout: vi.fn().mockResolvedValue(undefined),
      };
      attachLiveClientTo(capture, client);

      await expect(capture.captureReconcileBaseline(snapshot, 'FROM_NOW', 0)).rejects.toThrow(/not empty/i);

      expect(client.getMailboxLock).toHaveBeenCalledWith('Helpdesk/Test');
      expect(release).toHaveBeenCalledTimes(1);
      expect(client.logout).toHaveBeenCalledTimes(1);
      expect((capture as unknown as { connections: Map<number, unknown> }).connections.has(1)).toBe(false);
    });
  });

  describe('bootstrapQueue — synchronous baseline (P0-2)', () => {
    const bootstrap = (client: unknown) =>
      (service as unknown as { bootstrapQueue: (q: number, c: unknown) => Promise<void> }).bootstrapQueue(
        1,
        client,
      );

    it('FROM_NOW records high-water and imports nothing', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        uidValidity: null,
        syncState: 'OK',
        reconcileCause: null,
        mailboxEpoch: 1,
        cursorGeneration: 0,
      });
      await bootstrap({
        mailbox: { uidValidity: 7n, uidNext: 501, exists: 500 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      });
      // Bootstrap is a CAS on `uidValidity IS NULL` + generation + non-halted state
      // (two-pod safe) → updateMany.
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 1,
            uidValidity: null,
            syncState: 'OK',
          }),
          data: expect.objectContaining({ lastSeenUid: 500n, uidValidity: 7n, syncState: 'OK' }),
        }),
      );
    });

    it('BACKFILL uses the last N existing sparse UIDs, never UIDNEXT minus N', async () => {
      const backfillService = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'BACKFILL',
        TELECOM_HD_IMAP_BACKFILL_LIMIT: 2,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        uidValidity: null,
        syncState: 'OK',
        reconcileCause: null,
        mailboxEpoch: 1,
        cursorGeneration: 0,
        configGeneration: 0,
        bootstrapPolicy: null,
        bootstrapBackfillLimit: null,
      });
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 101 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        search: vi.fn().mockResolvedValue([2, 90, 95, 100]),
      };

      await (
        backfillService as unknown as { bootstrapQueue: (q: number, c: unknown) => Promise<void> }
      ).bootstrapQueue(1, client);

      expect(client.search).toHaveBeenCalledWith({ uid: '1:100' }, { uid: true });
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ configGeneration: 0 }),
          data: expect.objectContaining({ lastSeenUid: 94n, uidValidity: 7n }),
        }),
      );
    });

    it('does nothing when the queue is already bootstrapped (uidValidity set)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        uidValidity: 7n,
      });
      (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mockClear();
      // Give the client a REAL mailbox so the assertion genuinely guards the
      // `uidValidity !== null` early-return: were it removed, bootstrap would proceed to the
      // CAS updateMany (uidValidity 7n, uidNext 10 → high-water 9). With the guard, it must not.
      await bootstrap({
        mailbox: { uidValidity: 7n, uidNext: 10, exists: 9 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      });
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('capture-only re-proves a pre-bootstrapped queue before it can be considered a test target', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        useTls: true,
        mailbox: 'Helpdesk/Test',
        uidValidity: 7n,
        syncState: 'OK',
        reconcileCause: null,
      });
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 10, exists: 0 },
        list: vi.fn().mockResolvedValue([
          {
            path: 'Helpdesk/Test',
            pathAsListed: 'Helpdesk/Test',
            listed: true,
            flags: new Set(),
            specialUse: '\\Archive',
          },
        ]),
        getMailboxLock: vi.fn(),
      };

      // The old `uidValidity !== null` early-return must not bypass this LIST check.
      await expect(
        (capture as unknown as { bootstrapQueue: (q: number, c: unknown) => Promise<void> }).bootstrapQueue(
          1,
          client,
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(client.list).toHaveBeenCalledTimes(1);
      expect(client.getMailboxLock).not.toHaveBeenCalled();
      // Capture-only marks the queue *before* testing the live mailbox. A
      // provider-side special-use change must therefore fail closed on an
      // irreversibly retired queue rather than leave a reusable normal queue.
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 1, captureRetiredAt: null }),
          data: expect.objectContaining({ captureRetiredAt: expect.any(Date) }),
        }),
      );
    });

    it('capture-only refuses a pre-bootstrapped queue whose selected folder is no longer empty', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        useTls: true,
        mailbox: 'Helpdesk/Test',
        uidValidity: 7n,
        syncState: 'OK',
        reconcileCause: null,
      });
      const release = vi.fn();
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 11, exists: 1 },
        list: vi
          .fn()
          .mockResolvedValue([
            { path: 'Helpdesk/Test', pathAsListed: 'Helpdesk/Test', listed: true, flags: new Set() },
          ]),
        getMailboxLock: vi.fn().mockResolvedValue({ release }),
      };

      await expect(
        (capture as unknown as { bootstrapQueue: (q: number, c: unknown) => Promise<void> }).bootstrapQueue(
          1,
          client,
        ),
      ).rejects.toThrow(/not empty/i);
      expect(release).toHaveBeenCalledTimes(1);
      // The first arm is permanent even when the empty-folder proof fails;
      // operators must use a new queue/folder instead of turning this one back
      // into normal ticket ingress.
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 1, captureRetiredAt: null }),
          data: expect.objectContaining({ captureRetiredAt: expect.any(Date) }),
        }),
      );
    });

    it('P0-2: connectQueue captures the baseline DURING connect (not the first poll)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        uidValidity: null,
        syncState: 'OK',
        reconcileCause: null,
        mailboxEpoch: 1,
        cursorGeneration: 0,
      });
      // Uses the mocked ImapFlow (uidNext=10 → high-water 9). If connectQueue did not call
      // bootstrapQueue, no baseline would be written and mail arriving before the first
      // poll would be skipped.
      await (service as unknown as { connectQueue: (q: number, o: unknown) => Promise<void> }).connectQueue(
        1,
        { host: 'h', port: 993, secure: true, auth: { user: 'u', pass: 'p' } },
      );

      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 1,
            uidValidity: null,
            syncState: 'OK',
          }),
          data: expect.objectContaining({ lastSeenUid: 9n, uidValidity: 7n, syncState: 'OK' }),
        }),
      );
    });

    it('marks capture target ready only after connect completes its live empty-folder proof', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        type: 'IMAP',
        isEnabled: true,
        useTls: true,
        mailbox: 'Helpdesk/Test',
        uidValidity: 7n,
        syncState: 'OK',
        reconcileCause: null,
      });

      expect(capture.isCaptureQueueReady(1)).toBe(false);
      await (capture as unknown as { connectQueue: (q: number, o: unknown) => Promise<void> }).connectQueue(
        1,
        {
          host: 'h',
          port: 993,
          secure: true,
          auth: { user: 'u', pass: 'p' },
        },
      );

      expect(capture.isCaptureQueueReady(1)).toBe(true);
      await capture.onModuleDestroy();
    });

    it('drops a socket when synchronous bootstrap fails, then permits a fresh reconnect', async () => {
      const svc = makeInboundService(prisma as unknown as PrismaService);
      const bootstrap = vi
        .spyOn(
          svc as unknown as { bootstrapQueue: (q: number, c: unknown) => Promise<void> },
          'bootstrapQueue',
        )
        .mockRejectedValueOnce(new Error('baseline failure'))
        .mockResolvedValueOnce(undefined);
      const connect = (
        svc as unknown as {
          connectQueue: (q: number, o: unknown) => Promise<void>;
        }
      ).connectQueue.bind(svc);

      await connect(1, { host: 'h', port: 993, secure: true, auth: { user: 'u', pass: 'p' } });
      expect((svc as unknown as { connections: Map<number, unknown> }).connections.has(1)).toBe(false);

      await connect(1, { host: 'h', port: 993, secure: true, auth: { user: 'u', pass: 'p' } });
      expect(bootstrap).toHaveBeenCalledTimes(2);
      expect((svc as unknown as { connections: Map<number, unknown> }).connections.has(1)).toBe(true);
      await svc.onModuleDestroy();
    });
  });

  describe('supervisor — reconnect on config change / zero-queue fleet', () => {
    const imapOn = { ...TEST_CONFIG, TELECOM_HD_IMAP_ENABLED: true };
    const reconcile = (svc: InboundMailService) =>
      (svc as unknown as { reconcileConnections: () => Promise<void> }).reconcileConnections();
    const conns = (svc: InboundMailService) =>
      (svc as unknown as { connections: Map<number, unknown> }).connections;
    const row = (over: Record<string, unknown> = {}) => ({
      id: 1,
      emailAddress: 'q1@example.com',
      host: 'imap.example',
      port: 993,
      useTls: true,
      username: 'u',
      passwordEnc: 'secret',
      mailbox: 'INBOX',
      ...over,
    });

    it('keeps the SAME live connection when the queue config is unchanged', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row()]);
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      await reconcile(svc);
      const first = conns(svc).get(1);
      expect(first).toBeDefined();
      await reconcile(svc);
      expect(conns(svc).get(1)).toBe(first); // no reconnect
    });

    it('reconnects (new connection) when host/credentials change', async () => {
      const findMany = prisma.emailQueue.findMany as ReturnType<typeof vi.fn>;
      findMany.mockResolvedValue([row()]);
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      await reconcile(svc);
      const first = conns(svc).get(1);
      findMany.mockResolvedValue([row({ passwordEnc: 'ROTATED' })]); // credential rotation
      await reconcile(svc);
      const second = conns(svc).get(1);
      expect(second).toBeDefined();
      expect(second).not.toBe(first); // dropped + reconnected with new settings
    });

    it('reconnects when only the selected IMAP folder changes', async () => {
      const findMany = prisma.emailQueue.findMany as ReturnType<typeof vi.fn>;
      findMany.mockResolvedValue([row({ mailbox: 'INBOX' })]);
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      await reconcile(svc);
      const first = conns(svc).get(1);

      findMany.mockResolvedValue([row({ mailbox: 'Helpdesk/Test' })]);
      await reconcile(svc);

      expect(conns(svc).get(1)).toBeDefined();
      expect(conns(svc).get(1)).not.toBe(first);
    });

    it('capture-only logs out and drops an already-open socket when the selected folder becomes unsafe', async () => {
      const captureConfig = {
        ...imapOn,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
      };
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        row({ mailbox: '[Gmail]/All Mail' }),
      ]);
      const svc = makeInboundService(prisma as unknown as PrismaService, captureConfig);
      const live = { logout: vi.fn().mockResolvedValue(undefined) };
      conns(svc).set(1, live);
      (svc as unknown as { connectionFingerprints: Map<number, string> }).connectionFingerprints.set(
        1,
        'old',
      );

      await reconcile(svc);

      expect(live.logout).toHaveBeenCalledTimes(1);
      expect(conns(svc).has(1)).toBe(false);
      expect(
        (svc as unknown as { connectionFingerprints: Map<number, string> }).connectionFingerprints.has(1),
      ).toBe(false);
    });

    it('no-ops with an empty fleet (supervisor tolerates zero queues)', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      await expect(reconcile(svc)).resolves.toBeUndefined();
      expect(conns(svc).size).toBe(0);
    });

    it('P1-F: concurrent pollNow calls share one single-flight supervisor cycle', async () => {
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reconcileSpy = vi.fn(() => gate);
      const drainSpy = vi.fn().mockResolvedValue(undefined);
      (svc as unknown as { reconcileConnections: () => Promise<void> }).reconcileConnections = reconcileSpy;
      (svc as unknown as { drainDeliveries: () => Promise<void> }).drainDeliveries = drainSpy;

      const first = svc.pollNow();
      const second = svc.pollNow();
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);
      expect(drainSpy).toHaveBeenCalledTimes(1);
    });

    it('P1-F: one queue cannot be polled twice concurrently in this process', async () => {
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const once = vi.fn(() => gate);
      (svc as unknown as { pollQueueOnce: (q: number, c: unknown) => Promise<void> }).pollQueueOnce = once;
      const poll = (svc as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue.bind(
        svc,
      );

      const first = poll(1, {});
      const second = poll(1, {});
      await vi.waitFor(() => expect(once).toHaveBeenCalledTimes(1));
      expect(once).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);
      expect((svc as unknown as { pollingQueues: Set<number> }).pollingQueues.size).toBe(0);
    });

    it('P1-F: overlapping drain ticks share one in-flight cycle', async () => {
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await gate;
        return [];
      });
      const drain = (svc as unknown as { drainDeliveries: () => Promise<void> }).drainDeliveries.bind(svc);

      const first = drain();
      const second = drain();
      expect(prisma.inboundDelivery.findMany).toHaveBeenCalledTimes(1);
      release();
      await Promise.all([first, second]);
    });

    it('P1-F: refreshes PIPE loop-suppression addresses even when global IMAP is disabled', async () => {
      vi.useFakeTimers();
      try {
        const svc = makeInboundService(prisma as unknown as PrismaService, {
          ...TEST_CONFIG,
          TELECOM_HD_IMAP_ENABLED: false,
        });
        const refresh = vi.spyOn(
          svc as unknown as { refreshOwnAddresses: () => Promise<void> },
          'refreshOwnAddresses',
        );
        await svc.onModuleInit();
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(refresh).toHaveBeenCalledTimes(2);
        await svc.onModuleDestroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('cutover gate: disabled startup starts neither drain nor IMAP supervisor', async () => {
      vi.useFakeTimers();
      try {
        const svc = makeInboundService(prisma as unknown as PrismaService, {
          ...TEST_CONFIG,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_IMAP_ENABLED: true,
        });
        const drain = vi.spyOn(svc as unknown as { drainDeliveries: () => Promise<void> }, 'drainDeliveries');
        const refresh = vi.spyOn(
          svc as unknown as { refreshOwnAddresses: () => Promise<void> },
          'refreshOwnAddresses',
        );

        await svc.onModuleInit();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(drain).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect((svc as unknown as { connections: Map<number, unknown> }).connections.size).toBe(0);
        await svc.onModuleDestroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it('P1-F: stamps poll start and completion separately for honest operator liveness', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        isEnabled: true,
        departmentId: null,
        lastSeenUid: 10n,
        uidValidity: 7n,
        syncState: 'OK',
        lastError: null,
        cursorGeneration: 0,
      });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      const client = {
        mailbox: { uidValidity: 7n, uidNext: 11 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        fetch: vi.fn(function* () {
          // empty mailbox delta
        }),
      };
      await (svc as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(1, client);
      const livenessWrites = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls.map(
        ([arg]) => arg.data,
      );
      expect(livenessWrites).toContainEqual(expect.objectContaining({ lastPollStartedAt: expect.any(Date) }));
      expect(livenessWrites).toContainEqual(
        expect.objectContaining({ lastPollCompletedAt: expect.any(Date) }),
      );
    });
  });

  describe('drain — retry / quarantine (never discard)', () => {
    const drain = () => (service as unknown as { drainDeliveries: () => Promise<void> }).drainDeliveries();
    const raw = Buffer.from('From: a@b.example\r\nMessage-ID: <d-1@x>\r\n\r\nhello');

    function stageDelivery(over: Record<string, unknown> = {}) {
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, queueId: null },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 55,
        rawMime: raw,
        attempts: 0,
        queueId: null,
        ...over,
      });
    }

    it('cutover gate: leaves ACCEPTED/RETRY work untouched while delivery is disabled', async () => {
      stageDelivery();
      const disabled = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
      });

      await (disabled as unknown as { drainDeliveries: () => Promise<void> }).drainDeliveries();

      expect(prisma.inboundDelivery.findMany).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.ticketPost.findFirst).not.toHaveBeenCalled();
    });

    it('normal-delivery canary scopes the due scan to its one selected queue', async () => {
      const canary = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 77,
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 55,
      });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await (canary as unknown as { drainDeliveries: () => Promise<void> }).drainDeliveries();

      expect(prisma.inboundDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, queueId: 77, capturePromotedAt: { not: null } }),
        }),
      );
    });

    it('normal-delivery canary ignores a direct/stale call for a different delivery id', async () => {
      const canary = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 77,
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99,
      });

      await (
        canary as unknown as {
          processDelivery: (deliveryId: number, departmentId: number | undefined) => Promise<void>;
        }
      ).processDelivery(55, undefined);

      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.findUnique).not.toHaveBeenCalled();
    });

    it('normal-delivery canary claim fences the selected immutable delivery by queue id too', async () => {
      const canary = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 77,
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 55,
      });
      // The claim takes the queue row lock before it updates the delivery. A
      // reviewed canary is the only normal path allowed to lock a retired queue.
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ queueId: 77 });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 77, captureRetiredAt: new Date() },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await (
        canary as unknown as {
          processDelivery: (deliveryId: number, departmentId: number | undefined) => Promise<void>;
        }
      ).processDelivery(55, undefined);

      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, queueId: 77, capturePromotedAt: { not: null } }),
        }),
      );
      expect(prisma.inboundDelivery.findUnique).toHaveBeenCalledWith({
        where: { id: 55 },
        select: { queueId: true },
      });
    });

    it('normal-delivery canary leaves an old selected ACCEPTED row without promotion provenance unclaimed', async () => {
      const canary = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 77,
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 55,
      });
      // Real PostgreSQL rejects the claim because capturePromotedAt IS NULL. The
      // mock models that DB result; the assertions below make removing the
      // durable marker predicate turn this test red instead of false-green.
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 1 },
      ]);
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ queueId: 77 });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 77, captureRetiredAt: new Date() },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await (canary as unknown as { drainDeliveries: () => Promise<void> }).drainDeliveries();

      expect(prisma.inboundDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ capturePromotedAt: { not: null } }),
        }),
      );
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ capturePromotedAt: { not: null } }),
        }),
      );
      expect(prisma.inboundDelivery.findUnique).toHaveBeenCalledWith({
        where: { id: 55 },
        select: { queueId: true },
      });
      expect(
        (canary as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }).ticketsService
          .createTicket,
      ).not.toHaveBeenCalled();
    });

    it('marks a delivery PROCESSED after successful routing (lease-gated settle)', async () => {
      stageDelivery();
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await drain();
      // Settle is a lease-gated updateMany (where leaseOwner=us, state=PROCESSING).
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'PROCESSED', leaseOwner: null }),
        }),
      );
    });

    it('P1-E: semantic Message-ID conflict is settled QUARANTINED with durable forensic identity', async () => {
      const firstRaw = Buffer.from(
        'From: a@b.example\r\nTo: support@test.example\r\nMessage-ID: <semantic-conflict@x>\r\n\r\nfirst body',
      );
      const conflictingRaw = Buffer.from(
        'Received: from relay.example\r\nFrom: a@b.example\r\nTo: support@test.example\r\nMessage-ID: <semantic-conflict@x>\r\n\r\nDIFFERENT body',
      );
      let storedClaim: Record<string, unknown> | null = null;
      (prisma.inboundMessageClaim.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(storedClaim),
      );
      (prisma.inboundMessageClaim.createMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          if (storedClaim) return Promise.resolve({ count: 0 });
          storedClaim = { ...data };
          return Promise.resolve({ count: 1 });
        },
      );
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await (
        service as unknown as {
          processRawMessage: (
            source: Buffer,
            departmentId: number | undefined,
            opts: { deliveryId: number; syntheticSeed: string },
          ) => Promise<unknown>;
        }
      ).processRawMessage(firstRaw, 1, { deliveryId: 54, syntheticSeed: 'imap:1:1:7:54' });

      stageDelivery({
        rawMime: conflictingRaw,
        attempts: 1,
        transport: 'IMAP',
        queueId: 1,
        transportKey: 'imap:1:1:7:55',
      });
      await drain();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'QUARANTINED' }),
        }),
      );
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING', leaseOwner: expect.any(String) }),
          data: expect.objectContaining({ observedMessageId: '<semantic-conflict@x>' }),
        }),
      );
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ action: 'mail.message_id_conflict' }) }),
      );
    });

    it('P1-E: two different IMAP UIDs with byte-identical headerless MIME create two tickets', async () => {
      const headerless = Buffer.from(
        'From: a@b.example\r\nTo: support@test.example\r\nSubject: same\r\n\r\nsame',
      );
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 1 },
        { id: 56, departmentId: 1 },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { id: number } }) =>
          Promise.resolve({
            id: where.id,
            rawMime: headerless,
            attempts: 1,
            transport: 'IMAP',
            queueId: 9,
            uidValidity: 77n,
            uid: BigInt(where.id),
            transportKey: `imap:9:1:77:${where.id}`,
          }),
      );
      // Behave like TicketPost.inboundMessageId's real unique backstop: if production code
      // wrongly seeds headerless identity from bytes/contentHash, the second lookup finds the
      // first post and this test turns red rather than false-greening on a stateless mock.
      const seenPostKey = new Map<string, { id: number; ticketId: number }>();
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { inboundMessageId?: { in?: string[] }; ticketId?: number } }) => {
          const key = where.inboundMessageId?.in?.[0];
          if (!key) return Promise.resolve(null);
          const existing = seenPostKey.get(key);
          if (existing) return Promise.resolve(existing);
          seenPostKey.set(key, { id: seenPostKey.size + 900, ticketId: seenPostKey.size + 90 });
          return Promise.resolve(null);
        },
      );
      await drain();
      expect(
        (service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }).ticketsService
          .createTicket,
      ).toHaveBeenCalledTimes(2);
    });

    it('a claim that loses the CAS race (count 0) is a no-op', async () => {
      stageDelivery();
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      await drain();
      // Claiming now locks the queue lifecycle first. The single lookup is
      // that lock precondition; a losing claim must not issue the later full
      // delivery read or route a ticket.
      expect(prisma.inboundDelivery.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.inboundDelivery.findUnique).toHaveBeenCalledWith({
        where: { id: 55 },
        select: { queueId: true },
      });
      expect(prisma.ticketPost.findFirst).not.toHaveBeenCalled();
    });

    it('reclaims a stale PROCESSING delivery whose lease has expired', async () => {
      // The due query must include expired-lease PROCESSING rows.
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, queueId: null },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 55,
        rawMime: raw,
        attempts: 1,
        queueId: null,
      });
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await drain();
      const dueWhere = (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        where: { OR: Array<{ state?: unknown; leaseExpiresAt?: unknown }> };
      };
      // The PROCESSING branch of the due-query MUST be gated on an EXPIRED lease — otherwise
      // the drain would re-select rows under a live lease and double-process them.
      const dueProcessing = dueWhere.where.OR.find((c) => c.state === 'PROCESSING');
      expect(dueProcessing?.leaseExpiresAt).toEqual({ lt: expect.any(Date) });
      // The claim CAS must likewise accept a PROCESSING row only when its lease expired.
      const claimWhere = (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as { where: { OR: Array<{ state?: unknown; leaseExpiresAt?: unknown }> } };
      const claimProcessing = claimWhere.where.OR.find((c) => c.state === 'PROCESSING');
      expect(claimProcessing?.leaseExpiresAt).toEqual({ lt: expect.any(Date) });
    });

    it('increments attempts in the CLAIM CAS (so a lease-exceeded flow still counts)', async () => {
      stageDelivery({ attempts: 1 });
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await drain();
      // The FIRST updateMany is the claim; it must advance attempts, not only the settle.
      const claim = (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        data: { attempts?: unknown };
      };
      expect(claim.data.attempts).toEqual({ increment: 1 });
    });

    it('a transient failure below the limit → RETRY with backoff (raw retained)', async () => {
      // `attempts: 1` is the value AFTER the claim increment (the mock findUnique returns the
      // post-claim row); the settle re-uses it, so RETRY records attempts:1.
      stageDelivery({ attempts: 1 });
      (
        service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }
      ).ticketsService.createTicket = vi.fn();
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db blip'));
      await drain();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'RETRY', attempts: 1 }),
        }),
      );
    });

    it('exhausted attempts → QUARANTINED (never discarded; raw MIME kept)', async () => {
      stageDelivery({ attempts: 5 }); // post-claim value == maxAttempts → this failure quarantines
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('still bad'));
      await drain();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'QUARANTINED', attempts: 5 }),
        }),
      );
    });

    it('a delivery whose attempts exceed the budget is FAST-quarantined without reprocessing', async () => {
      // Simulates a message whose processing repeatedly outlived the lease: each reclaim
      // incremented attempts past the budget, so the terminal write never landed. On the next
      // claim it must quarantine at once, WITHOUT running the slow routing again.
      stageDelivery({ attempts: 7 }); // > maxAttempts (5)
      const createTicket = vi.fn();
      (
        service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }
      ).ticketsService.createTicket = createTicket;
      await drain();
      expect(createTicket).not.toHaveBeenCalled();
      expect(prisma.ticketPost.findFirst).not.toHaveBeenCalled(); // routing never entered
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'QUARANTINED' }),
        }),
      );
    });

    it('a delivery with missing rawMime is QUARANTINED, not silently dropped', async () => {
      stageDelivery({ rawMime: null });
      await drain();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'QUARANTINED' }),
        }),
      );
    });

    it('P1-H: external raw-storage read failure settles RETRY, then QUARANTINED at the attempt budget', async () => {
      const rawStorage = {
        read: vi.fn().mockRejectedValue(new Error('filesystem unavailable: /private/path')),
      } as unknown as InboundRawStorageService;
      const ops = makeInboundService(prisma as unknown as PrismaService, TEST_CONFIG, rawStorage);
      const drainOps = () => (ops as unknown as { drainDeliveries: () => Promise<void> }).drainDeliveries();

      stageDelivery({
        rawMime: null,
        rawStorageKey: 'inbound-raw/00000000-0000-4000-8000-000000000001.eml',
        attempts: 1,
      });
      await drainOps();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({
            state: 'RETRY',
            lastError: 'Inbound raw MIME storage temporarily unavailable',
          }),
        }),
      );

      stageDelivery({
        rawMime: null,
        rawStorageKey: 'inbound-raw/00000000-0000-4000-8000-000000000001.eml',
        attempts: 5,
      });
      await drainOps();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({
            state: 'QUARANTINED',
            lastError: 'Inbound raw MIME storage remained unavailable after retry budget',
          }),
        }),
      );
    });

    it('CF1: an IMAP re-fetch of header-less mail the LEGACY poller already ticketed is deduped, not duplicated', async () => {
      // The pre-ledger poller stamped `<imap-<queueId>-<uidValidity>-<uid>@helpdesk.invalid>`
      // on header-less mail. A RESUME_MIGRATED re-fetch hashes to a DIFFERENT synthetic id, so
      // dedup must ALSO match the legacy transport form — else it creates a duplicate ticket.
      const headerless = Buffer.from('From: a@b.example\r\nSubject: hi\r\n\r\nbody'); // no Message-ID
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 1 },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 55,
        rawMime: headerless,
        attempts: 1,
        transport: 'IMAP',
        queueId: 5,
        departmentId: 1,
        mailboxEpoch: 1,
        uidValidity: 42n,
        uid: 75n,
      });
      const legacyId = '<imap-5-42-75@helpdesk.invalid>';
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { inboundMessageId?: { in?: string[] } } }) =>
          (where?.inboundMessageId?.in ?? []).includes(legacyId)
            ? Promise.resolve({ id: 900, ticketId: 90 })
            : Promise.resolve(null),
      );
      const createTicket = vi.fn();
      (
        service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }
      ).ticketsService.createTicket = createTicket;
      await drain();
      expect(createTicket).not.toHaveBeenCalled(); // deduped — no duplicate ticket
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'SKIPPED', ticketId: 90 }),
        }),
      );
    });

    it('P0-A: never applies the legacy headerless bridge after a mailbox epoch changes', async () => {
      const headerless = Buffer.from('From: a@b.example\r\nSubject: new mailbox mail\r\n\r\nbody');
      const legacyId = '<imap-5-42-75@helpdesk.invalid>';
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 1 },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 55,
        rawMime: headerless,
        attempts: 1,
        transport: 'IMAP',
        queueId: 5,
        departmentId: 1,
        mailboxEpoch: 2,
        uidValidity: 42n,
        uid: 75n,
        transportKey: 'imap:5:2:42:75',
      });
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { inboundMessageId?: { in?: string[] } } }) => {
          const ids = where?.inboundMessageId?.in ?? [];
          // This simulates the old ticket post. A correct epoch-2 delivery must never query it.
          if (ids.includes(legacyId)) return Promise.resolve({ id: 900, ticketId: 90 });
          return Promise.resolve(null);
        },
      );
      const createTicket = vi
        .fn()
        .mockResolvedValue({ id: 101, mask: 'TT-000101', subject: 'new mailbox mail' });
      (
        service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }
      ).ticketsService.createTicket = createTicket;

      await drain();

      expect(createTicket).toHaveBeenCalledTimes(1);
      const dedupCall = (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        where: { inboundMessageId: { in: string[] } };
      };
      expect(dedupCall.where.inboundMessageId.in).not.toContain(legacyId);
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'PROCESSED', ticketId: 101 }),
        }),
      );
    });

    it('P1 ACL: writes the new ticket owner before a post lookup can fail after ticket creation', async () => {
      const routedRaw = Buffer.from('From: a@b.example\r\nSubject: route to C\r\n\r\nbody');
      stageDelivery({
        rawMime: routedRaw,
        attempts: 1,
        queueId: 7,
        departmentId: 33,
        transportKey: 'imap:7:1:9:55',
        routingSnapshot: [],
      });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 33 },
      ]);
      const createTicket = vi.fn().mockResolvedValue({ id: 42, mask: 'TT-000042', subject: 'route to C' });
      (
        service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }
      ).ticketsService.createTicket = createTicket;
      let postLookup = 0;
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(() => {
        postLookup += 1;
        if (postLookup === 1) return Promise.resolve(null); // inbound idempotency lookup
        const ticketOwnerWasFenced = (
          prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>
        ).mock.calls.some((call) => {
          const args = call[0] as { data?: Record<string, unknown> } | undefined;
          return args?.data?.effectiveOwnerKind === 'TICKET' && args.data?.effectiveOwnerTicketId === 42;
        });
        // This assertion is deliberately inside the next operation: removing or moving the
        // fence after the post lookup makes this test red rather than merely checking a final
        // call list that could be satisfied too late.
        expect(ticketOwnerWasFenced).toBe(true);
        return Promise.reject(new Error('post lookup failed after ticket creation'));
      });

      await drain();

      expect(createTicket).toHaveBeenCalledTimes(1);
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'RETRY' }),
        }),
      );
    });

    it('P1 ACL: resets to UNRESOLVED when the post-create ticket-owner fence cannot be written', async () => {
      const routedRaw = Buffer.from('From: a@b.example\r\nSubject: owner fence failure\r\n\r\nbody');
      stageDelivery({
        rawMime: routedRaw,
        attempts: 1,
        queueId: 7,
        departmentId: 33,
        transportKey: 'imap:7:1:9:55',
        routingSnapshot: [],
      });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 33 },
      ]);
      (
        service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }
      ).ticketsService.createTicket = vi
        .fn()
        .mockResolvedValue({ id: 42, mask: 'TT-000042', subject: 'owner fence failure' });
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve(
            data.effectiveOwnerKind === 'TICKET' && data.effectiveOwnerTicketId === 42
              ? { count: 0 }
              : { count: 1 },
          ),
      );

      await drain();

      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({
            state: 'RETRY',
            effectiveOwnerKind: 'UNRESOLVED',
            effectiveOwnerDepartmentId: null,
            effectiveOwnerTicketId: null,
          }),
        }),
      );
    });

    it('P1 ACL: known inbound-post dedup is fenced to its ticket before the delivery is skipped', async () => {
      stageDelivery({ attempts: 1, departmentId: 11, transportKey: 'imap:7:1:9:55', routingSnapshot: [] });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 11 },
      ]);
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 97, ticketId: 42 });

      await drain();

      expect(
        (service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }).ticketsService
          .createTicket,
      ).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ effectiveOwnerKind: 'TICKET', effectiveOwnerTicketId: 42 }),
        }),
      );
    });

    it('P1 ACL: a finalized logical-duplicate copy inherits the winner ticket, never its route', async () => {
      stageDelivery({ attempts: 1, departmentId: 11, transportKey: 'imap:7:1:9:55', routingSnapshot: [] });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 11 },
      ]);
      let duplicateClaim: Record<string, unknown> | null = null;
      (prisma.inboundMessageClaim.createMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          duplicateClaim = { ...data, winnerDeliveryId: 88, ticketId: 42 };
          return Promise.resolve({ count: 0 });
        },
      );
      (prisma.inboundMessageClaim.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(duplicateClaim),
      );

      await drain();

      expect(
        (service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }).ticketsService
          .createTicket,
      ).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ effectiveOwnerKind: 'TICKET', effectiveOwnerTicketId: 42 }),
        }),
      );
    });

    it('P1 ACL: an unfinished logical duplicate stays UNRESOLVED until its winner finalizes', async () => {
      stageDelivery({ attempts: 1, departmentId: 11, transportKey: 'imap:7:1:9:55', routingSnapshot: [] });
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: 11 },
      ]);
      let duplicateClaim: Record<string, unknown> | null = null;
      (prisma.inboundMessageClaim.createMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) => {
          duplicateClaim = { ...data, winnerDeliveryId: 88, ticketId: null };
          return Promise.resolve({ count: 0 });
        },
      );
      (prisma.inboundMessageClaim.findUnique as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve(duplicateClaim),
      );

      await drain();

      expect(
        (service as unknown as { ticketsService: { createTicket: ReturnType<typeof vi.fn> } }).ticketsService
          .createTicket,
      ).not.toHaveBeenCalled();
      const ownerWrites = (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call) => {
          const args = call[0] as { data?: Record<string, unknown> } | undefined;
          return args?.data?.effectiveOwnerKind !== undefined;
        },
      );
      expect(ownerWrites).toEqual([]);
    });

    it('P1 ACL: winner propagation includes semanticHash so a conflicting Message-ID copy is never relabelled', async () => {
      const svc = service as unknown as {
        processRawMessage: (
          source: Buffer,
          departmentId: number | undefined,
          opts: { deliveryId: number; leaseToken: string },
        ) => Promise<unknown>;
        ticketsService: { createTicket: ReturnType<typeof vi.fn> };
      };
      svc.ticketsService.createTicket = vi
        .fn()
        .mockResolvedValue({ id: 42, mask: 'TT-000042', subject: 'winner' });
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await svc.processRawMessage(raw, 11, { deliveryId: 77, leaseToken: 'lease-77' });

      const propagation = (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mock.calls.find(
        (call) => {
          const args = call[0] as
            | { where?: Record<string, unknown>; data?: Record<string, unknown> }
            | undefined;
          return (
            args?.data?.effectiveOwnerKind === 'TICKET' &&
            args.data?.effectiveOwnerTicketId === 42 &&
            args.where?.messageIdHash !== undefined
          );
        },
      )?.[0] as { where: Record<string, unknown> } | undefined;
      expect(propagation?.where).toEqual({
        messageIdHash: expect.any(String),
        semanticHash: expect.any(String),
      });
    });
  });

  // ─── PIPE ingress: idempotency-key collision ─────────────────────────────────
  describe('ingestRawMessage (PIPE) — delivery-id collision', () => {
    const ingest = (raw: string, extId = 'mta-77', queueId = 7) =>
      (
        service as unknown as {
          ingestRawMessage: (s: string, d: number | undefined, e: string, q: number) => Promise<void>;
        }
      ).ingestRawMessage(raw, undefined, extId, queueId);

    beforeEach(() => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        emailAddress: 'pipe-support@example.test',
        departmentId: 3,
        type: 'PIPE',
        isEnabled: true,
        captureRetiredAt: null,
      });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 7,
          emailAddress: 'pipe-support@example.test',
          departmentId: 3,
          sendAutoresponder: false,
          captureRetiredAt: null,
        },
      ]);
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 7,
          emailAddress: 'pipe-support@example.test',
          departmentId: 3,
          routingPriority: 100,
          sendAutoresponder: false,
          captureRetiredAt: null,
        },
      ]);
    });

    it('cutover gate: direct PIPE service invocation cannot create a ledger row while disabled', async () => {
      const disabled = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
      });
      await expect(
        (
          disabled as unknown as {
            ingestRawMessage: (s: string, d: number | undefined, e: string, q: number) => Promise<void>;
          }
        ).ingestRawMessage('message', undefined, 'mta-77', 7),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.emailQueue.findUnique).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
    });

    it('capture-only rejects PIPE before raw staging, queue lookup, or ledger acceptance', async () => {
      const capture = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
        TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 7,
      });
      const persist = vi.spyOn(
        capture as unknown as { persistRawMime: (source: Buffer) => Promise<unknown> },
        'persistRawMime',
      );
      await expect(
        (
          capture as unknown as {
            ingestRawMessage: (s: string, d: number | undefined, e: string, q: number) => Promise<void>;
          }
        ).ingestRawMessage('message', undefined, 'capture-other', 7),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(persist).not.toHaveBeenCalled();
      expect(prisma.emailQueue.findUnique).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
    });

    it('normal-delivery canary rejects a different PIPE queue before raw staging or ledger acceptance', async () => {
      const canary = makeInboundService(prisma as unknown as PrismaService, {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 8,
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 99,
      });
      const persist = vi.spyOn(
        canary as unknown as { persistRawMime: (source: Buffer) => Promise<unknown> },
        'persistRawMime',
      );

      await expect(
        (
          canary as unknown as {
            ingestRawMessage: (s: string, d: number | undefined, e: string, q: number) => Promise<void>;
          }
        ).ingestRawMessage('message', undefined, 'canary-other-queue', 7),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(persist).not.toHaveBeenCalled();
      expect(prisma.emailQueue.findUnique).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
    });

    it('normal PIPE refuses a capture-retired queue before it stages raw MIME', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        emailAddress: 'pipe-support@example.test',
        departmentId: 3,
        type: 'PIPE',
        isEnabled: true,
        captureRetiredAt: new Date(),
      });
      const persist = vi.spyOn(
        service as unknown as { persistRawMime: (source: Buffer) => Promise<unknown> },
        'persistRawMime',
      );

      await expect(ingest('message', 'retired-pipe')).rejects.toBeInstanceOf(ConflictException);

      expect(persist).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
    });

    it('P0 capture-retirement fence: PIPE acceptance SQL requires captureRetiredAt IS NULL', async () => {
      // Keep this focused on the durable acceptance transaction; inline ticket
      // processing is covered by drain tests and is irrelevant to the queue-row
      // lock predicate.
      const processDelivery = vi.spyOn(
        service as unknown as {
          processDelivery: (deliveryId: number, departmentId: number | undefined) => Promise<void>;
        },
        'processDelivery',
      );
      processDelivery.mockResolvedValue(undefined);
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) =>
        Promise.resolve(
          query.sql?.includes('"captureRetiredAt" IS NULL')
            ? [
                {
                  id: 7,
                  emailAddress: 'pipe-support@example.test',
                  departmentId: 3,
                  sendAutoresponder: false,
                },
              ]
            : [],
        ),
      );

      await ingest('message', 'pipe-marker-sql');

      expect(prisma.inboundDelivery.create).toHaveBeenCalledTimes(1);
      const [acceptanceQuery] = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0] ?? [];
      expect((acceptanceQuery as { sql?: string }).sql).toContain('"captureRetiredAt" IS NULL');
      expect(processDelivery).toHaveBeenCalledWith(1, 3);
    });

    it('P0 capture-retirement fence: a normal PIPE final-lock miss removes its queue-bound raw reservation', async () => {
      // A capture transition can win after the webhook's initial findUnique() but
      // after the short pre-write reservation commits but before the final acceptance
      // transaction locks the receiving queue. The raw file may have been written in
      // that interval, so failure must clean it in file -> stage -> marker order and
      // never create a ledger row.
      const storageKey = 'inbound-raw/00000000-0000-4000-8000-000000000010.eml';
      const storage = {
        allocateKey: vi.fn().mockReturnValue(storageKey),
        writeFenced: vi
          .fn()
          .mockImplementation(
            async (_source: Buffer, key: string, fence: (publish: () => Promise<void>) => Promise<void>) => {
              await fence(async () => undefined);
              return key;
            },
          ),
        removeFile: vi.fn().mockResolvedValue(undefined),
        commit: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
      };
      const svc = makeInboundService(
        prisma as unknown as PrismaService,
        TEST_CONFIG,
        storage as unknown as InboundRawStorageService,
      );
      const persist = vi.spyOn(
        svc as unknown as {
          persistRawMime: (source: Buffer, queueId: number, capture: boolean) => Promise<unknown>;
        },
        'persistRawMime',
      );
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation((query: { sql?: string }) => {
        if (query.sql?.includes('FROM "InboundRawMimeStaging"')) {
          return Promise.resolve([{ storageKey }]);
        }
        if (!query.sql?.includes('"captureRetiredAt" IS NULL')) return Promise.resolve([]);
        // Reservation succeeds, but the final SELECT ... FOR UPDATE sees the queue
        // after capture retirement and rejects the incoming PIPE delivery.
        return Promise.resolve(
          query.sql.includes('SELECT "id"\n        FROM "EmailQueue"') ? [{ id: 7 }] : [],
        );
      });
      const large = Buffer.alloc(1024 * 1024 + 1, 0x61);

      await expect(
        (
          svc as unknown as {
            ingestRawMessage: (
              source: Buffer,
              departmentId: number | undefined,
              externalId: string,
              queueId: number,
            ) => Promise<void>;
          }
        ).ingestRawMessage(large, undefined, 'pipe-fenced-large', 7),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(persist).toHaveBeenCalledWith(large, 7, false);
      expect(storage.allocateKey).toHaveBeenCalledTimes(1);
      expect(storage.writeFenced).toHaveBeenCalledWith(large, storageKey, expect.any(Function));
      expect(prisma.inboundRawMimeStaging.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ storageKey, queueId: 7 }) }),
      );
      expect(storage.removeFile).toHaveBeenCalledWith(storageKey);
      expect(prisma.inboundRawMimeStaging.deleteMany).toHaveBeenCalledWith({
        where: { storageKey, state: 'REAPING' },
      });
      expect(storage.commit).toHaveBeenCalledWith(storageKey);
      expect(storage.remove).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
    });

    it('#8: a reused delivery-id with DIFFERENT content is rejected (409), not silently lost', async () => {
      (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });
      // The stored delivery under this key had a different message (different hash).
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 81,
        contentHash: 'a-different-hash',
      });
      await expect(ingest('a brand new message')).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'mail.transport_collision',
            queueId: 7,
            deliveryId: 81,
          }),
        }),
      );
    });

    it('#8: a reused delivery-id with the SAME content is an idempotent no-op', async () => {
      const raw = 'same message body';
      const sameHash = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
      (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        contentHash: sameHash,
      });
      await expect(ingest(raw)).resolves.toBeUndefined();
    });

    it('requires an enabled PIPE queue and snapshots its department', async () => {
      await ingest('message', 'mta-88', 7);
      expect(prisma.inboundDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ queueId: 7, departmentId: 3, externalId: 'mta-88' }),
        }),
      );
      expect(prisma.inboundDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ envelopeTo: 'pipe-support@example.test' }),
        }),
      );
      const key = (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].data
        .transportKey as string;
      expect(key).toMatch(/^pipe:7:id-sha256:[a-f0-9]{64}$/);
      expect(key).not.toContain('mta-88');
    });

    it('P1-E: PIPE acceptance persists the immutable enabled-queue routing snapshot', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 7,
          emailAddress: 'pipe-support@example.test',
          departmentId: 3,
          routingPriority: 100,
          sendAutoresponder: false,
        },
        {
          id: 8,
          emailAddress: 'priority@example.test',
          departmentId: 4,
          routingPriority: 5,
          sendAutoresponder: true,
        },
      ]);

      await ingest('From: sender@example.test\r\nTo: pipe-support@example.test\r\n\r\nbody');

      expect(prisma.inboundDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            routingSnapshot: [
              {
                id: 8,
                emailAddress: 'priority@example.test',
                departmentId: 4,
                routingPriority: 5,
                sendAutoresponder: true,
              },
              {
                id: 7,
                emailAddress: 'pipe-support@example.test',
                departmentId: 3,
                routingPriority: 100,
                sendAutoresponder: false,
              },
            ],
          }),
        }),
      );
    });

    it('rejects disabled and non-PIPE queues before attempting a ledger insert', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 7,
        emailAddress: 'pipe-support@example.test',
        departmentId: null,
        type: 'PIPE',
        isEnabled: false,
      });
      await expect(ingest('message')).rejects.toThrow(/disabled/i);
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 7,
        emailAddress: 'imap@example.test',
        departmentId: null,
        type: 'IMAP',
        isEnabled: true,
      });
      await expect(ingest('message')).rejects.toThrow(/type PIPE/i);
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
    });

    it('fails closed when a P2002 cannot be verified against a transport row', async () => {
      (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(ingest('message')).rejects.toBeInstanceOf(ConflictException);
    });
  });

  // ─── A5(ii): loop / auto-reply detection ─────────────────────────────────────
  describe('isLoopMessage', () => {
    const call = (headers: Record<string, string>, fromEmail = 'someone@external.example') =>
      (service as unknown as { isLoopMessage: (p: unknown, f: string) => boolean }).isLoopMessage(
        { headers: new Map(Object.entries(headers)) },
        fromEmail,
      );

    it('skips Auto-Submitted other than "no"', () => {
      expect(call({ 'auto-submitted': 'auto-replied' })).toBe(true);
      expect(call({ 'auto-submitted': 'auto-generated' })).toBe(true);
      expect(call({ 'auto-submitted': 'no' })).toBe(false);
    });

    it('#10: self-loop matches even when MAIL_FROM is a `Name <addr>` display form', () => {
      const svc = new InboundMailService(
        { ...TEST_CONFIG, TELECOM_HD_MAIL_FROM: 'Support Desk <support@test.example>' },
        prisma as unknown as PrismaService,
        { reply: vi.fn(), createTicket: vi.fn(), getTicketByMask: vi.fn() } as unknown as TicketsService,
        { sendTemplate: vi.fn() } as unknown as MailService,
        undefined,
      );
      const loop = (svc as unknown as { isLoopMessage: (p: unknown, f: string) => boolean }).isLoopMessage(
        { headers: new Map() },
        'support@test.example',
      );
      expect(loop).toBe(true);
    });

    it('skips Precedence bulk/list/junk', () => {
      expect(call({ precedence: 'bulk' })).toBe(true);
      expect(call({ precedence: 'list' })).toBe(true);
    });

    it('skips a multi-valued (array) Precedence header', () => {
      // mailparser returns repeated header lines as an array — must still match.
      const headers = new Map<string, unknown>([['precedence', ['list', 'bulk']]]);
      const svc = service as unknown as { isLoopMessage: (p: unknown, f: string) => boolean };
      expect(svc.isLoopMessage({ headers }, 'someone@external.example')).toBe(true);
    });

    it('skips X-Loop / X-Autoreply', () => {
      expect(call({ 'x-loop': 'support@test.example' })).toBe(true);
      expect(call({ 'x-autoreply': 'yes' })).toBe(true);
    });

    it('skips mail from our own MAIL_FROM (self-loop)', () => {
      expect(call({}, 'support@test.example')).toBe(true);
      expect(call({}, 'SUPPORT@TEST.EXAMPLE')).toBe(true);
    });

    it('accepts an ordinary external message', () => {
      expect(call({ from: 'x' }, 'customer@acme.example')).toBe(false);
    });
  });

  // ─── hardening: retention prune + zero-queue supervisor ──────────────────────

  describe('pruneRawMime (retention)', () => {
    it('nulls raw MIME for terminal deliveries older than the retention window; keeps quarantined', async () => {
      const svc = makeInboundService(prisma as unknown as PrismaService);
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 44 }]);
      await (svc as unknown as { pruneRawMime: () => Promise<void> }).pruneRawMime();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: { in: [44] },
            rawPrunedAt: null,
          }),
          data: expect.objectContaining({ rawMime: null }),
        }),
      );
    });

    it('does nothing when retention is disabled (0 days)', async () => {
      const cfg = { ...TEST_CONFIG, TELECOM_HD_INBOUND_RAW_RETENTION_DAYS: 0 };
      const svc = makeInboundService(prisma as unknown as PrismaService, cfg);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockClear();
      await (svc as unknown as { pruneRawMime: () => Promise<void> }).pruneRawMime();
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit — zero-queue supervisor', () => {
    it('starts the poll supervisor even with no IMAP queues so a later queue is picked up', async () => {
      const cfg = { ...TEST_CONFIG, TELECOM_HD_IMAP_ENABLED: true };
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]); // zero queues
      const svc = makeInboundService(prisma as unknown as PrismaService, cfg);
      await svc.onModuleInit();
      expect((svc as unknown as { pollHandle: unknown }).pollHandle).not.toBeNull();
      await svc.onModuleDestroy();
    });

    it('normal-delivery canary skips global raw-retention work outside its queue', async () => {
      const cfg = {
        ...TEST_CONFIG,
        TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 77,
        TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 55,
        TELECOM_HD_IMAP_ENABLED: false,
      };
      const svc = makeInboundService(prisma as unknown as PrismaService, cfg);
      const prune = vi.spyOn(svc as unknown as { pruneRawMime: () => Promise<void> }, 'pruneRawMime');

      await svc.onModuleInit();

      expect(prune).not.toHaveBeenCalled();
      expect((svc as unknown as { pruneHandle: unknown }).pruneHandle).toBeNull();
      await svc.onModuleDestroy();
    });

    it('capture-only skips global raw retention and refuses shared INBOX before a connection', async () => {
      vi.useFakeTimers();
      try {
        const cfg = {
          ...TEST_CONFIG,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_IMAP_ENABLED: true,
        };
        (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>)
          .mockResolvedValueOnce([]) // loop-suppression addresses
          .mockResolvedValueOnce([
            {
              id: 1,
              type: 'IMAP',
              isEnabled: true,
              mailbox: 'INBOX',
              host: 'imap.example.test',
              port: 993,
              useTls: true,
              username: 'test',
              passwordEnc: 'ignored-before-connect',
            },
          ]);
        const svc = makeInboundService(prisma as unknown as PrismaService, cfg);
        const prune = vi.spyOn(svc as unknown as { pruneRawMime: () => Promise<void> }, 'pruneRawMime');
        const connect = vi.spyOn(
          svc as unknown as { connectQueue: (q: number, o: unknown) => Promise<void> },
          'connectQueue',
        );

        await svc.onModuleInit();

        expect(prune).not.toHaveBeenCalled();
        expect((svc as unknown as { pruneHandle: unknown }).pruneHandle).toBeNull();
        expect(connect).not.toHaveBeenCalled();
        expect((svc as unknown as { connections: Map<number, unknown> }).connections.size).toBe(0);
        expect(prisma.emailQueue.findMany).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ where: { isEnabled: true, type: 'IMAP', id: 1 } }),
        );
        expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: 1 },
            data: expect.objectContaining({
              lastError: 'Capture-only requires a TLS-enabled, canonical dedicated IMAP test folder',
            }),
          }),
        );
        await svc.onModuleDestroy();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
