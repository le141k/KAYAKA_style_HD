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
import { Readable } from 'node:stream';

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
  TELECOM_HD_FIELD_ENCRYPTION_KEY: undefined,
  TELECOM_HD_CLIENT_PORTAL_ENABLED: false,
};

function makePrismaMock() {
  return {
    emailQueue: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn() },
    emailParserRule: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    ticketPost: { findFirst: vi.fn(), update: vi.fn() },
    ticket: { findUnique: vi.fn().mockResolvedValue(null) },
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

    it('op:regex — rejects backtracking constructs instead of running them', () => {
      const criteria = [{ field: 'body', op: 'regex', value: '(a+)+$' }];
      expect(
        service.evaluateCriteria({ ...parsedBase, body: `${'a'.repeat(100_000)}!` }, criteria, 'ALL'),
      ).toBe(false);
    });

    it('op:regex — rejects unanchored unbounded scans', () => {
      const criteria = [{ field: 'body', op: 'regex', value: '.*never-present' }];
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

  describe('bounded MIME parsing', () => {
    function parsedMail(overrides: Record<string, unknown> = {}) {
      return {
        subject: 'Need help',
        text: 'body',
        html: false,
        from: { value: [{ address: 'customer@acme.example', name: 'Customer' }] },
        to: { value: [{ address: 'support@test.example', name: 'Support' }] },
        attachments: [],
        ...overrides,
      };
    }

    const validate = (value: unknown) =>
      (
        service as unknown as {
          validateParsedMail: (parsed: unknown) => void;
        }
      ).validateParsedMail(value);

    it('rejects oversized parsed subjects, reference sets and filenames', () => {
      expect(() => validate(parsedMail({ subject: 'x'.repeat(501) }))).toThrow('Subject exceeds');
      expect(() =>
        validate(
          parsedMail({
            references: Array.from({ length: 51 }, (_, index) => `<ref-${index}@example.test>`),
          }),
        ),
      ).toThrow('too many References');
      expect(() =>
        validate(
          parsedMail({
            attachments: [
              {
                filename: `${'x'.repeat(256)}.txt`,
                contentType: 'text/plain',
                content: Buffer.from('x'),
              },
            ],
          }),
        ),
      ).toThrow('Attachment filename exceeds');
      expect(() =>
        validate(
          parsedMail({
            attachments: Array.from({ length: 11 }, (_, index) => ({
              filename: `attachment-${index}.txt`,
              contentType: 'text/plain',
              content: Buffer.from('x'),
            })),
          }),
        ),
      ).toThrow('too many attachments');
    });

    it('rejects ambiguous From and an excessive address fanout', () => {
      expect(() =>
        validate(
          parsedMail({
            from: {
              value: [{ address: 'one@example.test' }, { address: 'two@example.test' }],
            },
          }),
        ),
      ).toThrow('exactly one From');
      expect(() =>
        validate(
          parsedMail({
            to: {
              value: Array.from({ length: 100 }, (_, index) => ({
                address: `recipient-${index}@example.test`,
              })),
            },
          }),
        ),
      ).toThrow('too many addresses');
    });

    it('rejects an already-buffered RFC822 body above its byte limit', () => {
      const bounded = service as unknown as {
        boundedInboundSource: (source: Buffer, maxBytes: number) => Buffer;
      };
      expect(() => bounded.boundedInboundSource(Buffer.alloc(6), 5)).toThrow('size limit');
    });

    it('stops a streamed RFC822 body as soon as it crosses the byte limit', async () => {
      const bounded = service as unknown as {
        boundedInboundSource: (source: Readable, maxBytes: number) => Readable;
      };
      const result = bounded.boundedInboundSource(Readable.from([Buffer.alloc(3), Buffer.alloc(3)]), 5);
      await expect(
        (async () => {
          for await (const _chunk of result) {
            // Drain until the bounded wrapper rejects.
          }
        })(),
      ).rejects.toThrow('size limit');
    });

    it('limits parser concurrency and wakes queued parsing in FIFO order', async () => {
      const withSlot = (
        service as unknown as {
          withParserSlot: <T>(work: () => Promise<T>) => Promise<T>;
        }
      ).withParserSlot.bind(service);
      const started: number[] = [];
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const secondGate = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const first = withSlot(async () => {
        started.push(1);
        await firstGate;
        return 1;
      });
      const second = withSlot(async () => {
        started.push(2);
        await secondGate;
        return 2;
      });
      const third = withSlot(async () => {
        started.push(3);
        return 3;
      });

      await vi.waitFor(() => expect(started).toEqual([1, 2]));
      releaseFirst();
      await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
      releaseSecond();
      await expect(Promise.all([first, second, third])).resolves.toEqual([1, 2, 3]);
    });
  });

  // ─── pollQueue durable UID state / poison handling ──────────────────────────

  describe('pollQueue — durable UID state', () => {
    /** A minimal fake ImapFlow that yields the given messages from fetch(). */
    function makeFakeClient(messages: Array<{ uid: number }>) {
      return {
        mailbox: { uidValidity: 77n },
        getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
        // eslint-disable-next-line @typescript-eslint/require-await
        fetch: vi.fn(function* (range: number | string) {
          for (const m of messages) {
            if (typeof range === 'number' && m.uid !== range) continue;
            yield m;
          }
        }),
        list: vi.fn().mockResolvedValue([]),
        mailboxCreate: vi.fn().mockResolvedValue(true),
        messageMove: vi.fn().mockResolvedValue(true),
      };
    }

    function mockState(value: unknown, legacy: unknown = null) {
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { section_key: { key: string } } }) =>
          Promise.resolve(where.section_key.key.startsWith('state:') ? value : legacy),
      );
    }

    it('migrates the legacy watermark and fetches using UID semantics', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      mockState(null, { value: 100 });
      const client = makeFakeClient([]);

      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockResolvedValue(undefined);

      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(client.fetch).toHaveBeenCalledWith('101:*', expect.objectContaining({ uid: true }), {
        uid: true,
      });
      expect(prisma.setting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            value: { uidValidity: '77', watermark: 100, failures: [] },
          }),
        }),
      );
      processSpy.mockRestore();
    });

    it('checkpoints each successfully finalized UID and skips old fetch echoes', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      mockState({ value: { uidValidity: '77', watermark: 100, failures: [] } });
      const client = makeFakeClient([{ uid: 100 }, { uid: 101 }, { uid: 102 }]);

      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockResolvedValue(undefined);

      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(prisma.setting.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.setting.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: { value: { uidValidity: '77', watermark: 102, failures: [] } },
        }),
      );
      processSpy.mockRestore();
    });

    it('keeps a first processing failure as a retry gap and continues with later mail', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      mockState({ value: { uidValidity: '77', watermark: 100, failures: [] } });
      const client = makeFakeClient([{ uid: 101 }, { uid: 102 }]);
      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockRejectedValueOnce(new Error('malformed MIME'))
        .mockResolvedValueOnce(undefined);

      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(client.messageMove).not.toHaveBeenCalled();
      expect(prisma.setting.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: {
            value: {
              uidValidity: '77',
              watermark: 102,
              failures: [expect.objectContaining({ uid: 101, status: 'pending', attempts: 1 })],
            },
          },
        }),
      );
    });

    it('dead-letters a repeatedly poison UID and continues checkpointing later mail', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      mockState({
        value: {
          uidValidity: '77',
          watermark: 101,
          failures: [
            {
              uid: 101,
              status: 'pending',
              attempts: 2,
              lastFailedAt: '2026-07-17T00:00:00.000Z',
            },
          ],
        },
      });
      const client = makeFakeClient([{ uid: 101 }, { uid: 102 }]);
      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockRejectedValueOnce(new Error('malformed MIME'))
        .mockResolvedValueOnce(undefined);

      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(client.mailboxCreate).toHaveBeenCalledWith('Helpdesk-Processing-Errors');
      expect(client.messageMove).toHaveBeenCalledWith(101, 'Helpdesk-Processing-Errors', {
        uid: true,
      });
      expect(prisma.setting.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: {
            value: {
              uidValidity: '77',
              watermark: 102,
              failures: [expect.objectContaining({ uid: 101, status: 'quarantined', attempts: 3 })],
            },
          },
        }),
      );
    });

    it('bounds a repeatedly missing retry gap as a terminal dead record', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      mockState({
        value: {
          uidValidity: '77',
          watermark: 101,
          failures: [
            {
              uid: 101,
              status: 'pending',
              attempts: 2,
              lastFailedAt: '2026-07-17T00:00:00.000Z',
            },
          ],
        },
      });
      const client = makeFakeClient([{ uid: 102 }]);
      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockResolvedValue(undefined);

      await (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(
        1,
        client,
      );

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(prisma.setting.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          update: {
            value: {
              uidValidity: '77',
              watermark: 102,
              failures: [expect.objectContaining({ uid: 101, status: 'missing', attempts: 3 })],
            },
          },
        }),
      );
    });

    it('fails closed when UIDVALIDITY changes instead of reusing the old watermark', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      mockState({ value: { uidValidity: '76', watermark: 900, failures: [] } });
      const client = makeFakeClient([]);

      await expect(
        (service as unknown as { pollQueue: (q: number, c: unknown) => Promise<void> }).pollQueue(1, client),
      ).rejects.toThrow('UIDVALIDITY changed');
      expect(client.fetch).not.toHaveBeenCalled();
      expect(prisma.setting.upsert).not.toHaveBeenCalled();
    });

    it('does not overlap two direct polls for the same queue', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 1,
        departmentId: null,
      });
      mockState({ value: { uidValidity: '77', watermark: 100, failures: [] } });
      const client = makeFakeClient([{ uid: 101 }]);
      let releaseProcess!: () => void;
      const processBlocked = new Promise<void>((resolve) => {
        releaseProcess = resolve;
      });
      const processSpy = vi
        .spyOn(service as unknown as { processMessage: () => Promise<void> }, 'processMessage')
        .mockReturnValue(processBlocked);
      const privateService = service as unknown as {
        pollQueue: (q: number, c: unknown) => Promise<void>;
      };

      const first = privateService.pollQueue(1, client);
      await vi.waitFor(() => expect(processSpy).toHaveBeenCalledTimes(1));
      await privateService.pollQueue(1, client);
      expect(client.getMailboxLock).toHaveBeenCalledTimes(1);

      releaseProcess();
      await first;
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
        processMessage: (m: unknown, d: number | undefined, id?: string) => Promise<void>;
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

    it('uses the deterministic IMAP fallback when the parsed Message-ID is empty', async () => {
      const noIdEmail = [
        'From: customer@acme.example',
        'To: support@test.example',
        'Subject: No message id',
        'Message-ID:',
        '',
        'Body text',
        '',
      ].join('\r\n');
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = callProcess(prisma as unknown as PrismaService);
      const fallback = '<imap-1-77-101@helpdesk.invalid>';

      await svc.processMessage({ source: Buffer.from(noIdEmail) }, 1, fallback);

      expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith({
        where: { messageId: fallback },
        select: { id: true },
      });
      expect(svc.ticketsService.createTicket).toHaveBeenCalledWith(
        expect.objectContaining({ incomingMessageId: fallback }),
      );
    });

    // Subject-mask threading ownership guard.
    const maskEmail = (from: string) =>
      [
        `From: ${from}`,
        'To: support@test.example',
        'Subject: Re: TT-000005 still broken',
        `Message-ID: <mask-${Math.random()}@x.example>`,
        '',
        'still broken',
        '',
      ].join('\r\n');

    it('does NOT thread by subject mask when the sender is not the ticket requester', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = callProcess(prisma as unknown as PrismaService);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 5,
        requesterEmail: 'owner@acme.example',
        user: null,
        recipients: [],
      });

      await svc.processMessage({ source: Buffer.from(maskEmail('attacker@evil.example')) }, 1);

      // Not threaded onto ticket 5; a new ticket is created instead.
      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
      expect(svc.ticketsService.createTicket).toHaveBeenCalledTimes(1);
    });

    it('threads by subject mask when the sender IS the ticket requester', async () => {
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const svc = callProcess(prisma as unknown as PrismaService);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 5,
        requesterEmail: 'owner@acme.example',
        user: null,
        recipients: [],
      });

      await svc.processMessage({ source: Buffer.from(maskEmail('Owner <owner@acme.example>')) }, 1);

      expect(svc.ticketsService.reply).toHaveBeenCalledTimes(1);
      expect(svc.ticketsService.createTicket).not.toHaveBeenCalled();
    });

    it('accepts a linked UserEmail or TicketRecipient as an authorized thread sender', () => {
      const senderCanReply = (
        service as unknown as {
          senderCanReply: (ticket: unknown, sender: string) => boolean;
        }
      ).senderCanReply.bind(service);
      const ticket = {
        id: 5,
        requesterEmail: 'primary@acme.example',
        user: { emails: [{ email: 'alias@acme.example' }] },
        recipients: [{ email: 'cc@partner.example' }],
      };

      expect(senderCanReply(ticket, 'ALIAS@acme.example')).toBe(true);
      expect(senderCanReply(ticket, 'cc@partner.example')).toBe(true);
      expect(senderCanReply(ticket, 'attacker@evil.example')).toBe(false);
    });

    it('does not trust an RFC reference unless its sender belongs to that ticket', async () => {
      const referencedEmail = [
        'From: attacker@evil.example',
        'To: support@test.example',
        'Subject: Re: a private thread',
        'Message-ID: <attacker-reply@evil.example>',
        'In-Reply-To: <owner-post@acme.example>',
        'References: <owner-post@acme.example>',
        '',
        'please append me',
        '',
      ].join('\r\n');
      (prisma.ticketPost.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { messageId: unknown } }) =>
          typeof where.messageId === 'object'
            ? Promise.resolve({
                ticketId: 5,
                ticket: {
                  id: 5,
                  requesterEmail: 'owner@acme.example',
                  user: { emails: [{ email: 'owner-alias@acme.example' }] },
                  recipients: [{ email: 'known-cc@acme.example' }],
                },
              })
            : Promise.resolve(null),
      );
      const svc = callProcess(prisma as unknown as PrismaService);

      await svc.processMessage({ source: Buffer.from(referencedEmail) }, 1);

      expect(svc.ticketsService.reply).not.toHaveBeenCalled();
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
