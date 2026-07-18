/**
 * Tests for InboundMailService parser rule helpers:
 *   - evaluateCriteria (ALL / ANY / regex)
 *   - applyParserRules (skip / route / stop-processing)
 *   - processMessage discard path (via applyParserRules mock)
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { InboundMailService } from './inbound.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TicketsService } from '../tickets/tickets.service';
import type { MailService } from './mail.service';
import type { AppConfig } from '../../config/configuration';

// Fake ImapFlow so connectQueue() can be exercised without a real IMAP server. The
// mailbox advertises UIDVALIDITY/UIDNEXT so the connect-time bootstrap barrier runs.
vi.mock('imapflow', () => ({
  ImapFlow: class {
    mailbox = { uidValidity: 7n, uidNext: 10, exists: 9 };
    connect() {
      return Promise.resolve();
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
  TELECOM_HD_IMAP_ENABLED: false,
  TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'FROM_NOW',
  TELECOM_HD_IMAP_BACKFILL_LIMIT: 0,
  TELECOM_HD_INBOUND_MAX_ATTEMPTS: 5,
  TELECOM_HD_FIELD_ENCRYPTION_KEY: undefined,
};

function makePrismaMock() {
  return {
    emailQueue: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    emailParserRule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ticketPost: { findFirst: vi.fn(), update: vi.fn() },
    ticket: { findUnique: vi.fn() },
    inboundDelivery: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    department: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
    // Advisory-lock raw query — default to "lock acquired".
    $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
  } as unknown as PrismaService;
}

function makeInboundService(prisma: PrismaService, config: AppConfig = TEST_CONFIG): InboundMailService {
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
      deliveryId?: number,
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

    it('skips (SKIPPED) a message whose Message-ID already exists on a post', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99, ticketId: 7 });
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(rawEmail), 1);
      expect(out.state).toBe('SKIPPED');
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
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

    it('#4: stamps the effective Message-ID + envelope + subject on the ledger row (atomic claim)', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      await svc.processRawMessage(Buffer.from(rawEmail), 1, 77);
      expect(prisma.inboundDelivery.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 77 },
          data: expect.objectContaining({
            messageId: '<dup-123@acme.example>',
            envelopeFrom: 'customer@acme.example',
            subject: 'Need help',
          }),
        }),
      );
    });

    it('#4: a concurrent duplicate loses the atomic claim (P2002) → SKIPPED, no ticket', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.inboundDelivery.update as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });
      const svc = svcOf();
      const out = await svc.processRawMessage(Buffer.from(rawEmail), 1, 77);
      expect(out.state).toBe('SKIPPED');
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
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
        expect.objectContaining({ where: { messageId: { in: [arg.incomingMessageId] } } }),
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
      opts: { vanish?: number[]; fetchOneThrowsAt?: number } = {},
    ) {
      const src = imapSrc;
      return {
        mailbox,
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: vi.fn(function* () {
          for (const uid of uids) yield { uid };
        }),
        fetchOne: vi.fn((uidStr: string) => {
          const uid = Number(uidStr);
          if (opts.fetchOneThrowsAt === uid) return Promise.reject(new Error('fetch reset'));
          if (opts.vanish?.includes(uid)) return Promise.resolve(false);
          return Promise.resolve({ uid, source: src(uid) });
        }),
      };
    }

    const poll = (client: unknown) =>
      (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(1, client);

    function queue(over: Record<string, unknown> = {}) {
      return {
        id: 1,
        isEnabled: true,
        departmentId: null,
        lastSeenUid: 100,
        uidValidity: 7n,
        syncState: 'OK',
        lastError: null,
        cursorGeneration: 0,
        ...over,
      };
    }

    beforeEach(() => {
      // Drain finds nothing by default so these tests isolate the accept phase.
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    });

    it('accepts new UIDs into the ledger and advances the cursor via monotonic CAS', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      const client = makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 });
      await poll(client);

      // IN-01: the discovery fetch is a real UID range — `{ uid: true }` is the THIRD arg
      // (folding it into the query object leaves it a *sequence* range).
      expect(client.fetch).toHaveBeenCalledWith('101:*', expect.anything(), { uid: true });
      expect(client.fetchOne).toHaveBeenCalledWith('102', expect.anything(), { uid: true });

      expect(prisma.inboundDelivery.create).toHaveBeenCalledTimes(2);
      // The ACTUAL raw bytes / hash / size must be persisted (durable, replayable) — not
      // just the transport key.
      const src102 = imapSrc(102);
      expect(prisma.inboundDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transport: 'IMAP',
            transportKey: 'imap:1:7:102',
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
            lastSeenUid: { lt: 102n },
            cursorGeneration: 0,
            syncState: 'OK',
          }),
          data: { lastSeenUid: 102n },
        }),
      );
    });

    it('#10: snapshots the queue department onto the delivery at acceptance', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ departmentId: 4 }),
      );
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));
      expect(prisma.inboundDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ departmentId: 4 }) }),
      );
    });

    it('processes out-of-order UIDs and advances the cursor to the max (no loss)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      await poll(makeLedgerClient([103, 101], { uidValidity: 7n, uidNext: 104 }));
      expect(prisma.inboundDelivery.create).toHaveBeenCalledTimes(2);
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 103n } }),
      );
    });

    it('fail-closed: a fetch error stops the poll WITHOUT advancing the cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      await poll(makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 }, { fetchOneThrowsAt: 101 }));
      // 101 failed before acceptance → nothing accepted, cursor NOT advanced.
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('fail-closed: a ledger DB error during accept does NOT advance the cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
      await poll(makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 }));
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('idempotent: a duplicate transport key (P2002) is a no-op and the cursor still advances', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });
      await poll(makeLedgerClient([101], { uidValidity: 7n, uidNext: 102 }));
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 101n } }),
      );
    });

    it('an EXPUNGE-vanished UID is skipped and the cursor advances past it (no wedge)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(queue());
      await poll(makeLedgerClient([101, 102], { uidValidity: 7n, uidNext: 103 }, { vanish: [101] }));
      // 101 vanished (no create), 102 accepted; cursor reaches 102.
      expect(prisma.inboundDelivery.create).toHaveBeenCalledTimes(1);
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastSeenUid: 102n } }),
      );
    });

    it('P0-3: a UIDVALIDITY change HALTS the queue (NEEDS_RECONCILIATION), accepts nothing', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        queue({ uidValidity: 7n }),
      );
      await poll(makeLedgerClient([1, 2], { uidValidity: 9n, uidNext: 50 }));
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
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
      expect(prisma.inboundDelivery.create).not.toHaveBeenCalled();
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
        uidValidity: null,
      });
      await bootstrap({
        mailbox: { uidValidity: 7n, uidNext: 501, exists: 500 },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      });
      // Bootstrap is a CAS on `uidValidity IS NULL` (two-pod safe) → updateMany.
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1, uidValidity: null },
          data: expect.objectContaining({ lastSeenUid: 500n, uidValidity: 7n, syncState: 'OK' }),
        }),
      );
    });

    it('does nothing when the queue is already bootstrapped (uidValidity set)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
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

    it('P0-2: connectQueue captures the baseline DURING connect (not the first poll)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        uidValidity: null,
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
          where: { id: 1, uidValidity: null },
          data: expect.objectContaining({ lastSeenUid: 9n, uidValidity: 7n, syncState: 'OK' }),
        }),
      );
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

    it('no-ops with an empty fleet (supervisor tolerates zero queues)', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      const svc = makeInboundService(prisma as unknown as PrismaService, imapOn);
      await expect(reconcile(svc)).resolves.toBeUndefined();
      expect(conns(svc).size).toBe(0);
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

    it('a claim that loses the CAS race (count 0) is a no-op', async () => {
      stageDelivery();
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      await drain();
      expect(prisma.inboundDelivery.findUnique).not.toHaveBeenCalled();
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

    it('CF1: an IMAP re-fetch of header-less mail the LEGACY poller already ticketed is deduped, not duplicated', async () => {
      // The pre-ledger poller stamped `<imap-<queueId>-<uidValidity>-<uid>@helpdesk.invalid>`
      // on header-less mail. A RESUME_MIGRATED re-fetch hashes to a DIFFERENT synthetic id, so
      // dedup must ALSO match the legacy transport form — else it creates a duplicate ticket.
      const headerless = Buffer.from('From: a@b.example\r\nSubject: hi\r\n\r\nbody'); // no Message-ID
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 55, departmentId: null },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 55,
        rawMime: headerless,
        attempts: 1,
        transport: 'IMAP',
        queueId: 5,
        uidValidity: 42n,
        uid: 75n,
      });
      const legacyId = '<imap-5-42-75@helpdesk.invalid>';
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { messageId?: { in?: string[] } } }) =>
          (where?.messageId?.in ?? []).includes(legacyId)
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
  });

  // ─── PIPE ingress: idempotency-key collision ─────────────────────────────────
  describe('ingestRawMessage (PIPE) — delivery-id collision', () => {
    const ingest = (raw: string, extId?: string) =>
      (
        service as unknown as {
          ingestRawMessage: (s: string, d: number | undefined, e?: string) => Promise<void>;
        }
      ).ingestRawMessage(raw, undefined, extId);

    it('#8: a reused delivery-id with DIFFERENT content is rejected (409), not silently lost', async () => {
      (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });
      // The stored delivery under this key had a different message (different hash).
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        contentHash: 'a-different-hash',
      });
      await expect(ingest('a brand new message', 'mta-77')).rejects.toBeInstanceOf(ConflictException);
    });

    it('#8: a reused delivery-id with the SAME content is an idempotent no-op', async () => {
      const raw = 'same message body';
      const sameHash = createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex');
      (prisma.inboundDelivery.create as ReturnType<typeof vi.fn>).mockRejectedValue({ code: 'P2002' });
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        contentHash: sameHash,
      });
      await expect(ingest(raw, 'mta-77')).resolves.toBeUndefined();
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
});
