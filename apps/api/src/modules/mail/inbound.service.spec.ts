/**
 * Tests for InboundMailService parser rule helpers:
 *   - evaluateCriteria (ALL / ANY / regex)
 *   - applyParserRules (skip / route / stop-processing)
 *   - processMessage discard path (via applyParserRules mock)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboundMailService } from './inbound.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { TicketsService } from '../tickets/tickets.service';
import type { MailService } from './mail.service';
import type { AppConfig } from '../../config/configuration';

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
  TELECOM_HD_UPLOAD_DIR: '/tmp/uploads',
  TELECOM_HD_UPLOAD_MAX_SIZE_MB: 25,
  TELECOM_HD_FIELD_ENCRYPTION_KEY: undefined,
};

function makePrismaMock() {
  return {
    emailQueue: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    emailParserRule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ticketPost: { findFirst: vi.fn(), update: vi.fn() },
    department: { findFirst: vi.fn().mockResolvedValue({ id: 1 }) },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

function makeInboundService(prisma: PrismaService): InboundMailService {
  const ticketsService = {
    reply: vi.fn(),
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

  // ─── pollQueue: UID cursor / bootstrap / poison isolation ────────────────────

  describe('pollQueue — UID cursor, bootstrap & poison isolation', () => {
    /**
     * A minimal fake ImapFlow: yields the given messages from fetch() and (optionally)
     * exposes UIDVALIDITY / UIDNEXT on `client.mailbox`, as ImapFlow does once a
     * mailbox lock is held.
     */
    function makeFakeClient(
      messages: Array<{ uid: number }>,
      mailbox?: { uidValidity?: number; uidNext?: number },
    ) {
      return {
        mailbox,
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: vi.fn(function* () {
          for (const m of messages) yield m;
        }),
      };
    }

    function stubProcess(impl?: (msg: { uid: number }) => Promise<void>) {
      return vi
        .spyOn(
          service as unknown as { processMessage: (m: { uid: number }) => Promise<void> },
          'processMessage',
        )
        .mockImplementation(impl ?? (() => Promise.resolve()));
    }

    function callPoll(client: unknown): Promise<void> {
      return (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );
    }

    beforeEach(() => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
    });

    it('IN-01: passes { uid: true } as the THIRD fetch() argument (real UID range)', async () => {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: { uid: 100, uidValidity: 7 },
      });
      const client = makeFakeClient([], { uidValidity: 7, uidNext: 101 });
      const spy = stubProcess();

      await callPoll(client);

      // Range starts after the watermark; uid:true is the 3rd arg, not folded into query.
      expect(client.fetch).toHaveBeenCalledWith('101:*', expect.anything(), { uid: true });
      spy.mockRestore();
    });

    it('persists the new max UID (object watermark) and skips already-seen messages', async () => {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: { uid: 100, uidValidity: 7 },
      });
      const client = makeFakeClient([{ uid: 100 }, { uid: 101 }, { uid: 102 }], {
        uidValidity: 7,
        uidNext: 103,
      });
      const spy = stubProcess();

      await callPoll(client);

      expect(spy).toHaveBeenCalledTimes(2); // 100 skipped, 101 + 102 processed
      expect(prisma.setting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { value: { uid: 102, uidValidity: 7 } } }),
      );
      spy.mockRestore();
    });

    it('honours a legacy bare-number watermark and upgrades it to the object format', async () => {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 100 });
      const client = makeFakeClient([{ uid: 101 }], { uidValidity: 7, uidNext: 102 });
      const spy = stubProcess();

      await callPoll(client);

      expect(spy).toHaveBeenCalledTimes(1); // does NOT re-bootstrap / skip mail
      expect(prisma.setting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { value: { uid: 101, uidValidity: 7 } } }),
      );
      spy.mockRestore();
    });

    it('IN-02: first connect (no watermark) bootstraps to uidNext-1 WITHOUT importing history', async () => {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      // Mailbox already holds 500 old messages (uidNext = 501).
      const client = makeFakeClient([{ uid: 1 }, { uid: 500 }], { uidValidity: 7, uidNext: 501 });
      const spy = stubProcess();

      await callPoll(client);

      expect(spy).not.toHaveBeenCalled(); // no historical tickets, no autoresponder storm
      expect(client.fetch).not.toHaveBeenCalled();
      expect(prisma.setting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { value: { uid: 500, uidValidity: 7 } } }),
      );
      spy.mockRestore();
    });

    it('IN-01: a UIDVALIDITY change triggers a controlled rebootstrap, not reprocessing', async () => {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: { uid: 100, uidValidity: 7 },
      });
      // Server reset its UID space: uidValidity is now 9.
      const client = makeFakeClient([{ uid: 1 }, { uid: 2 }], { uidValidity: 9, uidNext: 51 });
      const spy = stubProcess();

      await callPoll(client);

      expect(spy).not.toHaveBeenCalled();
      expect(client.fetch).not.toHaveBeenCalled();
      expect(prisma.setting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { value: { uid: 50, uidValidity: 9 } } }),
      );
      spy.mockRestore();
    });

    it('IN-03: a poison message stops the poll without advancing the watermark (retried next poll)', async () => {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: { uid: 100, uidValidity: 7 },
      });
      const client = makeFakeClient([{ uid: 101 }, { uid: 102 }], { uidValidity: 7, uidNext: 103 });
      const spy = stubProcess((m) =>
        m.uid === 101 ? Promise.reject(new Error('bad MIME')) : Promise.resolve(),
      );

      await callPoll(client);

      // Stopped at the poison message: 102 not yet reached, watermark NOT advanced.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(prisma.setting.upsert).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('IN-03: a poison message is quarantined after MAX attempts so later mail is delivered', async () => {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: { uid: 100, uidValidity: 7 },
      });
      const goodSeen: number[] = [];
      const spy = stubProcess((m) => {
        if (m.uid === 101) return Promise.reject(new Error('bad MIME'));
        goodSeen.push(m.uid);
        return Promise.resolve();
      });

      // Poll repeatedly; the poison UID is retried then quarantined (MAX_POISON_ATTEMPTS = 5).
      for (let i = 0; i < 5; i++) {
        await callPoll(makeFakeClient([{ uid: 101 }, { uid: 102 }], { uidValidity: 7, uidNext: 103 }));
      }

      // After quarantine, 102 is delivered and the watermark reaches 102.
      expect(goodSeen).toContain(102);
      expect(prisma.setting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { value: { uid: 102, uidValidity: 7 } } }),
      );
      spy.mockRestore();
    });
  });

  // ─── processMessage: Message-ID idempotency ──────────────────────────────────

  describe('processMessage — Message-ID idempotency (IN-03)', () => {
    const rawEmail = Buffer.from(
      [
        'From: Alice <alice@example.com>',
        'To: support@23telecom.example',
        'Subject: Please help',
        'Message-ID: <dup-123@example.com>',
        '',
        'Body text here',
        '',
      ].join('\r\n'),
    );

    function callProcess(msg: unknown): Promise<void> {
      return (
        service as unknown as { processMessage: (m: unknown, d?: number) => Promise<void> }
      ).processMessage(msg, 1);
    }

    function tickets(): { createTicket: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> } {
      return (
        service as unknown as {
          ticketsService: { createTicket: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
        }
      ).ticketsService;
    }

    it('skips a message whose Message-ID was already stored on a post', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 42 });

      await callProcess({ uid: 5, source: rawEmail });

      expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { messageId: '<dup-123@example.com>' } }),
      );
      expect(tickets().createTicket).not.toHaveBeenCalled();
      expect(tickets().reply).not.toHaveBeenCalled();
    });

    it('creates a ticket when the Message-ID has not been seen before', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await callProcess({ uid: 6, source: rawEmail });

      expect(tickets().createTicket).toHaveBeenCalledTimes(1);
    });
  });
});
