/**
 * Tests for InboundMailService parser rule helpers:
 *   - evaluateCriteria (ALL / ANY / regex)
 *   - applyParserRules (skip / route / stop-processing)
 *   - processMessage discard path (via applyParserRules mock)
 */
import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
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
  TELECOM_HD_IMAP_ENABLED: false,
  TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'FROM_NOW',
  TELECOM_HD_IMAP_BACKFILL_LIMIT: 0,
  TELECOM_HD_INBOUND_MAX_ATTEMPTS: 5,
  TELECOM_HD_INBOUND_MAX_MB: 30,
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

function makeInboundService(prisma: PrismaService): InboundMailService {
  const ticketsService = {
    reply: vi.fn().mockResolvedValue({ id: 1 }),
    getTicketByMask: vi.fn(),
    createTicket: vi.fn().mockResolvedValue({ id: 1, mask: 'TT-000001', subject: 'test' }),
  } as unknown as TicketsService;

  const mailService = {
    sendTemplate: vi.fn().mockResolvedValue(undefined),
  } as unknown as MailService;

  return new InboundMailService(
    TEST_CONFIG,
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
        expect.objectContaining({ messageId: '<dup-123@acme.example>' }),
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
        messageId: string;
      };
      // Deterministic synthetic id → a retry of the same bytes dedups to the same post.
      expect(arg.messageId).toMatch(/^<inbound-[0-9a-f]{64}@23telecom\.local>$/);
      expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { messageId: arg.messageId } }),
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

    it('does NOT thread by mask when the sender is not the requester → new ticket', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      svc.ticketsService.getTicketByMask = vi
        .fn()
        .mockResolvedValue({ id: 5, mask: 'TT-000005', requesterEmail: 'owner@acme.example' });
      await svc.processRawMessage(Buffer.from(maskEmail('attacker@evil.example')), 1);
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
    });

    it('threads by mask (reply) when the sender IS the requester', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      svc.ticketsService.getTicketByMask = vi
        .fn()
        .mockResolvedValue({ id: 5, mask: 'TT-000005', requesterEmail: 'owner@acme.example' });
      const out = await svc.processRawMessage(Buffer.from(maskEmail('owner@acme.example')), 1);
      expect(out.state).toBe('PROCESSED');
      expect(svc.ticketsService.reply).toHaveBeenCalledTimes(1);
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
    });

    it('IN-10: NotFoundException from mask lookup → new ticket', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      svc.ticketsService.getTicketByMask = vi.fn().mockRejectedValue(new NotFoundException('nope'));
      await svc.processRawMessage(Buffer.from(maskEmail('owner@acme.example')), 1);
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
    });

    it('IN-10: a NON-NotFound error from mask lookup propagates (no silent duplicate ticket)', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = svcOf();
      svc.ticketsService.getTicketByMask = vi.fn().mockRejectedValue(new Error('db timeout'));
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
      expect(prisma.emailQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
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
      await bootstrap({ getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }) });
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

    it('a transient failure below the limit → RETRY with backoff (raw retained)', async () => {
      stageDelivery({ attempts: 0 });
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
      stageDelivery({ attempts: 4 }); // maxAttempts = 5 → this attempt quarantines
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('still bad'));
      await drain();
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 55, state: 'PROCESSING' }),
          data: expect.objectContaining({ state: 'QUARANTINED', attempts: 5 }),
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
