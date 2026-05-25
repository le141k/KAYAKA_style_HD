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

  // ─── pollQueue UID watermark ─────────────────────────────────────────────────

  describe('pollQueue — UID watermark', () => {
    /** A minimal fake ImapFlow that yields the given messages from fetch(). */
    function makeFakeClient(messages: Array<{ uid: number }>) {
      return {
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: vi.fn(function* () {
          for (const m of messages) yield m;
        }),
      };
    }

    it('reads the last-seen UID from Setting and fetches only newer messages', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 100 });
      const client = makeFakeClient([]);

      // Stub processMessage so we only assert fetch/watermark behaviour
      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockResolvedValue(undefined);

      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      // Range must start just after the watermark
      expect(client.fetch).toHaveBeenCalledWith('101:*', expect.objectContaining({ uid: true }));
      processSpy.mockRestore();
    });

    it('persists the new max UID and skips already-seen messages', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ value: 100 });
      // 100 = already seen (skipped), 101 + 102 = new
      const client = makeFakeClient([{ uid: 100 }, { uid: 101 }, { uid: 102 }]);

      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockResolvedValue(undefined);

      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      // uid 100 skipped; 101 and 102 processed
      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(prisma.setting.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { value: 102 } }));
      processSpy.mockRestore();
    });
  });

  // ─── A3: dedup by Message-ID ─────────────────────────────────────────────────
  describe('processMessage dedup (A3)', () => {
    const rawEmail = [
      'From: customer@acme.example',
      'To: support@test.example',
      'Subject: Need help',
      'Message-ID: <dup-123@acme.example>',
      '',
      'Body text',
      '',
    ].join('\r\n');

    const callProcess = (prismaArg: PrismaService) =>
      makeInboundService(prismaArg) as unknown as {
        processMessage: (m: unknown, d: number | undefined) => Promise<void>;
        ticketsService: { createTicket: ReturnType<typeof vi.fn>; reply: ReturnType<typeof vi.fn> };
      };

    it('skips a message whose Message-ID already exists on a post', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99 });
      const svc = callProcess(prisma as unknown as PrismaService);
      await svc.processMessage({ source: Buffer.from(rawEmail) }, 1);
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
    });

    it('creates a ticket when the Message-ID is new', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = callProcess(prisma as unknown as PrismaService);
      await svc.processMessage({ source: Buffer.from(rawEmail) }, 1);
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
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

    it('skips Precedence bulk/list/junk', () => {
      expect(call({ precedence: 'bulk' })).toBe(true);
      expect(call({ precedence: 'list' })).toBe(true);
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
