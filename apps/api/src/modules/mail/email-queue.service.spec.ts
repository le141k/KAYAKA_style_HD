import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailQueueService } from './email-queue.service';
import {
  CreateEmailQueueSchema,
  PromoteCapturedInboundSchema,
  ReconcileEmailQueueSchema,
  ReplayQuarantinedInboundSchema,
  UpdateEmailQueueSchema,
} from './dto';
import type { PrismaService } from '../../prisma/prisma.service';
import { MailAccessPolicy } from './mail-access-policy.service';

// ─── helpers ────────────────────────────────────────────────────────────────

const TEST_FIELD_ENCRYPTION_KEY = 'a'.repeat(64);

/** Build the Prisma-shaped record that the service would return (no passwordEnc). */
function makeSafeQueue(overrides: Partial<SafeQueue> = {}): SafeQueue {
  return {
    id: 1,
    type: 'IMAP' as const,
    emailAddress: 'support@example.com',
    host: 'imap.example.com',
    port: 993,
    username: 'support',
    useTls: true,
    mailbox: 'INBOX',
    departmentId: null,
    signature: '',
    routingPriority: 100,
    sendAutoresponder: false,
    isEnabled: false,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    syncState: 'OK',
    lastError: null,
    lastSeenUid: 0n,
    uidValidity: null,
    cursorGeneration: 0,
    mailboxEpoch: 1,
    configGeneration: 0,
    reconcileCause: null,
    reconcileRequestedAt: null,
    bootstrapPolicy: null,
    bootstrapBackfillLimit: null,
    captureRetiredAt: null,
    lastConnectedAt: null,
    lastConnectionAttemptAt: null,
    lastDisconnectedAt: null,
    lastConnectionErrorAt: null,
    lastPollStartedAt: null,
    lastPollAt: null,
    lastPollCompletedAt: null,
    lastAcceptedAt: null,
    ...overrides,
  };
}

type SafeQueue = {
  id: number;
  type: 'IMAP' | 'POP3' | 'PIPE';
  emailAddress: string;
  host: string;
  port: number;
  username: string;
  useTls: boolean;
  mailbox: string;
  departmentId: number | null;
  signature: string;
  routingPriority: number;
  sendAutoresponder: boolean;
  isEnabled: boolean;
  createdAt: Date;
  syncState: 'OK' | 'BOOTSTRAPPING' | 'NEEDS_RECONCILIATION';
  lastError: string | null;
  lastSeenUid: bigint;
  uidValidity: bigint | null;
  cursorGeneration: number;
  mailboxEpoch: number;
  configGeneration: number;
  reconcileCause:
    | 'LEGACY_MIGRATION'
    | 'UIDVALIDITY_CHANGED'
    | 'MAILBOX_IDENTITY_CHANGED'
    | 'MANUAL_FORCE'
    | 'TRANSPORT_COLLISION'
    | 'UNKNOWN'
    | null;
  reconcileRequestedAt: Date | null;
  bootstrapPolicy: 'FROM_NOW' | 'BACKFILL' | null;
  bootstrapBackfillLimit: number | null;
  captureRetiredAt: Date | null;
  lastConnectedAt: Date | null;
  lastConnectionAttemptAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastConnectionErrorAt: Date | null;
  lastPollStartedAt: Date | null;
  lastPollAt: Date | null;
  lastPollCompletedAt: Date | null;
  lastAcceptedAt: Date | null;
};

function makePrismaMock() {
  const emailQueue = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  // Preserve the legacy focused tests' fixtures while exercising the scoped service APIs.
  // Production uses `findFirst`/`deleteMany` so department predicates are enforceable.
  emailQueue.findFirst.mockImplementation((args: unknown) => emailQueue.findUnique(args));
  emailQueue.deleteMany.mockImplementation(async (args: { where: unknown }) => {
    const current = await emailQueue.findUnique({ where: args.where });
    if (!current) return { count: 0 };
    await emailQueue.delete({ where: args.where });
    return { count: 1 };
  });
  const prisma = {
    emailQueue,
    departmentStaff: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    inboundDelivery: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      groupBy: vi.fn().mockResolvedValue([]),
      aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: null } }),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    inboundAuditLog: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 1, captureRetiredAt: null }]),
  } as unknown as Record<string, unknown>;
  const inboundDelivery = prisma.inboundDelivery as {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  inboundDelivery.findFirst.mockImplementation((args: unknown) => inboundDelivery.findUnique(args));
  (prisma as { $transaction: ReturnType<typeof vi.fn> }).$transaction = vi.fn(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  return prisma as unknown as PrismaService;
}

/** The projection the reconcile `before` snapshot reads (now includes `type` for the
 *  IMAP-only guard). */
function makeCursorBefore(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    type: 'IMAP',
    uidValidity: null,
    lastSeenUid: 0n,
    syncState: 'NEEDS_RECONCILIATION',
    reconcileCause: 'LEGACY_MIGRATION',
    cursorGeneration: 0,
    mailboxEpoch: 1,
    configGeneration: 0,
    mailbox: 'INBOX',
    useTls: true,
    captureRetiredAt: null,
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('EmailQueueService', () => {
  let service: EmailQueueService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let baselineProbe: {
    captureReconcileBaseline: ReturnType<typeof vi.fn>;
    isCaptureQueueReady: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    prisma = makePrismaMock();
    baselineProbe = {
      captureReconcileBaseline: vi.fn().mockResolvedValue({
        uidValidity: 7n,
        boundary: 100,
        cursor: 100,
        selectedUids: [],
      }),
      isCaptureQueueReady: vi.fn().mockReturnValue(true),
    };
    service = new EmailQueueService(
      prisma as unknown as PrismaService,
      undefined,
      baselineProbe as unknown as import('./inbound.service').InboundMailService,
      { TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY } as never,
      undefined,
      new MailAccessPolicy(prisma as unknown as PrismaService),
    );
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an array of queues', async () => {
      const rows = [makeSafeQueue({ id: 1 }), makeSafeQueue({ id: 2 })];
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);

      const result = await service.list();

      expect(result).toEqual(rows.map((row) => ({ ...row, allowedModes: [] })));
      expect(prisma.emailQueue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.not.objectContaining({ passwordEnc: true }) }),
      );
    });

    it('never includes passwordEnc in the select clause', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.list();

      const calls = (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<
        [{ select: Record<string, boolean> }]
      >;
      expect(calls[0]?.[0]?.select).not.toHaveProperty('passwordEnc');
    });
  });

  // ── get ───────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns the queue when found', async () => {
      const row = makeSafeQueue({ id: 5 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(row);

      const result = await service.get(5);

      expect(result).toEqual({ ...row, allowedModes: [] });
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.get(99)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never includes passwordEnc in the select clause', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());

      await service.get(1);

      const calls = (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mock.calls as unknown as Array<
        [{ select: Record<string, boolean> }]
      >;
      expect(calls[0]?.[0]?.select).not.toHaveProperty('passwordEnc');
    });
  });

  // ── create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('maps password → passwordEnc and excludes it from the response', async () => {
      const created = makeSafeQueue({ emailAddress: 'new@example.com' });
      (prisma.emailQueue.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

      const result = await service.create({
        type: 'IMAP',
        emailAddress: 'new@example.com',
        host: 'imap.example.com',
        port: 993,
        username: 'user',
        password: 's3cr3t',
        useTls: true,
        signature: '',
        isEnabled: false,
      });

      // Response must not carry the password
      expect(result).not.toHaveProperty('passwordEnc');
      expect(result).not.toHaveProperty('password');

      // A non-empty credential must be encrypted at rest; the service must never use
      // the legacy development plaintext fallback for an operator-entered password.
      const createCall = (prisma.emailQueue.create as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown>; select: Record<string, boolean> },
      ];
      expect(createCall[0].data).toHaveProperty('passwordEnc');
      expect(createCall[0].data['passwordEnc']).toMatch(/^v1:/);
      expect(createCall[0].data).not.toHaveProperty('password');
      expect(createCall[0].select).not.toHaveProperty('passwordEnc');
      expect(createCall[0].data.mailbox).toBe('INBOX');
    });

    it('refuses a non-empty queue password when field encryption is unavailable before Prisma writes', async () => {
      const unsafe = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        undefined,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );

      await expect(
        unsafe.create({
          type: 'IMAP',
          emailAddress: 'secret@example.com',
          host: 'imap.example.com',
          port: 993,
          username: 'user',
          password: 'fresh-app-password',
          useTls: true,
          signature: '',
          isEnabled: false,
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.emailQueue.create).not.toHaveBeenCalled();
    });

    it('stores empty passwordEnc when no password supplied', async () => {
      (prisma.emailQueue.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());

      await service.create({
        type: 'IMAP',
        emailAddress: 'x@example.com',
        host: '',
        port: 993,
        username: '',
        password: '',
        useTls: true,
        signature: '',
        isEnabled: false,
      });

      const createCall = (prisma.emailQueue.create as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(createCall[0].data.passwordEnc).toBe('');
    });

    it('defaults routingPriority to 100 for backward-compatible internal queue creation', async () => {
      (prisma.emailQueue.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());

      await service.create({
        type: 'IMAP',
        emailAddress: 'priority-default@example.com',
        host: '',
        port: 993,
        username: '',
        password: '',
        useTls: true,
        signature: '',
        isEnabled: false,
      });

      const createCall = (prisma.emailQueue.create as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(createCall[0].data.routingPriority).toBe(100);
    });

    it('validates and normalizes an IMAP folder while defaulting legacy callers to INBOX', () => {
      expect(CreateEmailQueueSchema.parse({ emailAddress: 'folder@example.com' }).mailbox).toBe('INBOX');
      expect(
        CreateEmailQueueSchema.parse({ emailAddress: 'folder@example.com', mailbox: '  Helpdesk/Test  ' })
          .mailbox,
      ).toBe('Helpdesk/Test');
      expect(
        CreateEmailQueueSchema.safeParse({ emailAddress: 'folder@example.com', mailbox: '   ' }).success,
      ).toBe(false);
      expect(
        CreateEmailQueueSchema.safeParse({
          emailAddress: 'folder@example.com',
          mailbox: `A${'x'.repeat(255)}`,
        }).success,
      ).toBe(false);
      expect(
        CreateEmailQueueSchema.safeParse({ emailAddress: 'folder@example.com', mailbox: 'INBOX\nother' })
          .success,
      ).toBe(false);
      expect(UpdateEmailQueueSchema.parse({ expectedConfigGeneration: 0 }).mailbox).toBeUndefined();
      expect(UpdateEmailQueueSchema.safeParse({ expectedConfigGeneration: 0, mailbox: '   ' }).success).toBe(
        false,
      );
    });
  });

  // ── update ────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('rejects a queue mutation without the configuration version at the HTTP boundary', () => {
      expect(UpdateEmailQueueSchema.safeParse({ isEnabled: true }).success).toBe(false);
      expect(UpdateEmailQueueSchema.safeParse({ isEnabled: true, expectedConfigGeneration: 0 }).success).toBe(
        true,
      );
    });

    it('maps password → passwordEnc when provided', async () => {
      const existing = makeSafeQueue({ id: 3 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await service.update(3, { password: 'newPass', expectedConfigGeneration: 0 });

      const updateCall = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ];
      expect(updateCall[0].data).toHaveProperty('passwordEnc');
      expect(updateCall[0].data['passwordEnc']).toMatch(/^v1:/);
      expect(updateCall[0].data).not.toHaveProperty('password');
      expect(updateCall[0].where).toMatchObject({
        AND: expect.arrayContaining([expect.objectContaining({ configGeneration: 0 })]),
      });
      expect(updateCall[0].data).toMatchObject({ configGeneration: { increment: 1 } });
    });

    it('does not touch passwordEnc when password not in dto', async () => {
      const existing = makeSafeQueue({ id: 3 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await service.update(3, { isEnabled: true, expectedConfigGeneration: 0 });

      const updateCall = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(updateCall[0].data).not.toHaveProperty('passwordEnc');
      expect(updateCall[0].data).not.toHaveProperty('password');
    });

    it('refuses a password update when field encryption is unavailable before the CAS write', async () => {
      const unsafe = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        undefined,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue({ id: 3 }));

      await expect(
        unsafe.update(3, { password: 'fresh-app-password', expectedConfigGeneration: 0 }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('refuses an edit while the queue owns a synchronous IMAP reconcile baseline', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, syncState: 'BOOTSTRAPPING' }),
      );

      await expect(
        service.update(3, { isEnabled: true, expectedConfigGeneration: 0 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when queue does not exist', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        service.update(999, { isEnabled: true, expectedConfigGeneration: 0 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('identity guard: a host change on a bootstrapped IMAP queue resets the cursor + halts', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, type: 'IMAP', host: 'old.example.com', uidValidity: 42n }),
      );

      await service.update(3, { host: 'new.example.com', expectedConfigGeneration: 0 });

      const call = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).toMatchObject({
        host: 'new.example.com',
        uidValidity: null,
        lastSeenUid: 0n,
        syncState: 'NEEDS_RECONCILIATION',
        cursorGeneration: { increment: 1 },
        mailboxEpoch: { increment: 1 },
        reconcileCause: 'MAILBOX_IDENTITY_CHANGED',
      });
    });

    it('identity guard: changing the IMAP folder bumps epoch/generation and requires reconcile', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, mailbox: 'INBOX', uidValidity: 42n }),
      );

      await service.update(3, { mailbox: 'Helpdesk/Test', expectedConfigGeneration: 0 });

      const call = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).toMatchObject({
        mailbox: 'Helpdesk/Test',
        uidValidity: null,
        lastSeenUid: 0n,
        syncState: 'NEEDS_RECONCILIATION',
        reconcileCause: 'MAILBOX_IDENTITY_CHANGED',
        cursorGeneration: { increment: 1 },
        mailboxEpoch: { increment: 1 },
      });
    });

    it('refuses changing the active capture queue back to shared INBOX', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 3,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, mailbox: 'Helpdesk/Test' }),
      );

      await expect(
        capture.update(3, { mailbox: 'INBOX', expectedConfigGeneration: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('permanently refuses normal-ingress reconfiguration of a capture-retired queue before any write', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({
          id: 3,
          mailbox: 'Helpdesk/Capture-2026-07-23',
          captureRetiredAt: new Date('2026-07-23T11:00:00.000Z'),
        }),
      );

      await expect(
        service.update(3, { signature: 'normal ingress must use a new queue', expectedConfigGeneration: 0 }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('identity guard: a password-only change never resets the cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, type: 'IMAP', uidValidity: 42n }),
      );

      await service.update(3, { password: 'rotated', expectedConfigGeneration: 0 });

      const call = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).not.toHaveProperty('uidValidity');
      expect(call[0].data).not.toHaveProperty('syncState');
      expect(call[0].data).not.toHaveProperty('mailboxEpoch');
    });

    it('identity guard: an identity change on a never-bootstrapped queue STILL bumps epoch + halts', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, type: 'IMAP', host: 'old.example.com', uidValidity: null }),
      );

      await service.update(3, { host: 'new.example.com', expectedConfigGeneration: 0 });

      const call = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).toMatchObject({
        syncState: 'NEEDS_RECONCILIATION',
        mailboxEpoch: { increment: 1 },
        reconcileCause: 'MAILBOX_IDENTITY_CHANGED',
      });
    });

    it('rejects a stale full-form update instead of reverting a newer mailbox configuration', async () => {
      const old = makeSafeQueue({ id: 3, host: 'imap-a.example', mailboxEpoch: 1, cursorGeneration: 4 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(old);
      (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 }); // another operator committed A→B first

      await expect(
        service.update(3, { host: 'imap-a.example', expectedConfigGeneration: 0 }),
      ).rejects.toBeInstanceOf(ConflictException);

      const calls = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0]).toMatchObject({
        where: { AND: expect.arrayContaining([expect.objectContaining({ configGeneration: 0 })]) },
      });
    });

    it('P1: refuses an update that was read before reconcile entered BOOTSTRAPPING', async () => {
      const beforeReconcile = makeSafeQueue({
        id: 3,
        syncState: 'NEEDS_RECONCILIATION',
        configGeneration: 7,
        cursorGeneration: 4,
        mailboxEpoch: 2,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(beforeReconcile);
      (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { AND?: Array<Record<string, unknown>> } }) => {
          const fence = where.AND ?? [];
          const hasEveryPreReconcileSnapshotField = [
            { configGeneration: 7 },
            { syncState: 'NEEDS_RECONCILIATION' },
            { cursorGeneration: 4 },
            { mailboxEpoch: 2 },
          ].every((expected) =>
            fence.some((candidate) =>
              Object.entries(expected).every(([key, value]) => candidate[key] === value),
            ),
          );
          // Simulate beginMailboxReconcile() winning after the form read. If any fence is
          // removed, this mock returns a false success and the expectation below turns red.
          return Promise.resolve({ count: hasEveryPreReconcileSnapshotField ? 0 : 1 });
        },
      );

      await expect(
        service.update(3, { signature: 'stale form', expectedConfigGeneration: 7 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('IMAP → PIPE → IMAP transitions consume epochs and never resurrect the old cursor', async () => {
      const imap = makeSafeQueue({
        id: 3,
        type: 'IMAP',
        mailboxEpoch: 1,
        cursorGeneration: 2,
        uidValidity: 42n,
      });
      const pipe = makeSafeQueue({
        id: 3,
        type: 'PIPE',
        mailboxEpoch: 2,
        cursorGeneration: 3,
        configGeneration: 1,
        uidValidity: null,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(imap)
        .mockResolvedValueOnce(pipe)
        .mockResolvedValueOnce(pipe)
        .mockResolvedValueOnce(imap);
      await service.update(3, { type: 'PIPE', expectedConfigGeneration: 0 });
      await service.update(3, { type: 'IMAP', expectedConfigGeneration: 1 });
      const calls = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      for (const [call] of calls) {
        expect((call as { data: Record<string, unknown> }).data).toMatchObject({
          mailboxEpoch: { increment: 1 },
          cursorGeneration: { increment: 1 },
          uidValidity: null,
          lastSeenUid: 0n,
          reconcileCause: 'MAILBOX_IDENTITY_CHANGED',
        });
      }
    });
  });

  // ── delete ────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes the queue when found', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());
      (prisma.emailQueue.delete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await expect(service.delete(1, { expectedConfigGeneration: 0 })).resolves.toBeUndefined();
      expect(prisma.emailQueue.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              expect.objectContaining({ configGeneration: 0 }),
              expect.objectContaining({ syncState: { not: 'BOOTSTRAPPING' } }),
            ]),
          },
        }),
      );
    });

    it('throws NotFoundException when queue does not exist', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.delete(404, { expectedConfigGeneration: 0 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.emailQueue.delete).not.toHaveBeenCalled();
    });

    it('rejects a stale delete and never lets the UI be the only BOOTSTRAPPING guard', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ configGeneration: 3, syncState: 'BOOTSTRAPPING' }),
      );
      await expect(service.delete(1, { expectedConfigGeneration: 3 })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.emailQueue.deleteMany).not.toHaveBeenCalled();

      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ configGeneration: 3 }),
      );
      await expect(service.delete(1, { expectedConfigGeneration: 2 })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.emailQueue.deleteMany).not.toHaveBeenCalled();
    });

    it('permanently refuses deleting a capture-retired queue before the delete CAS', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({
          captureRetiredAt: new Date('2026-07-23T11:00:00.000Z'),
          mailbox: 'Helpdesk/Capture-2026-07-23',
        }),
      );

      await expect(service.delete(1, { expectedConfigGeneration: 0 })).rejects.toBeInstanceOf(
        ConflictException,
      );

      expect(prisma.emailQueue.deleteMany).not.toHaveBeenCalled();
    });
  });

  // ── #7 reconcile / quarantine ─────────────────────────────────────────────

  describe('reconcile (cutover)', () => {
    const fromNow = {
      mode: 'FROM_NOW' as const,
      expectedCursorGeneration: 0,
      confirm: true,
      reason: 'clean cutover',
    };
    const stageMailboxReconcile = (before = makeCursorBefore()) => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(before)
        .mockResolvedValueOnce({
          ...before,
          host: 'imap.example.com',
          port: 993,
          username: 'support',
          passwordEnc: '',
          useTls: true,
          cursorGeneration: before.cursorGeneration + 1,
        })
        .mockResolvedValueOnce(
          makeSafeQueue({
            syncState: 'OK',
            reconcileCause: null,
            cursorGeneration: before.cursorGeneration + 1,
          }),
        );
    };

    it('FROM_NOW captures the exact baseline before success and records requested + completed audit rows', async () => {
      stageMailboxReconcile();
      const result = await service.reconcile(1, fromNow, { staffId: 42, email: 'ops@example.com' });

      expect(baselineProbe.captureReconcileBaseline).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, mailbox: 'INBOX', mailboxEpoch: 1, cursorGeneration: 1 }),
        'FROM_NOW',
        0,
      );
      const updates = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls;
      expect(updates[0]?.[0]).toMatchObject({
        where: expect.objectContaining({
          cursorGeneration: 0,
          mailboxEpoch: 1,
          mailbox: 'INBOX',
          syncState: 'NEEDS_RECONCILIATION',
        }),
        data: expect.objectContaining({ syncState: 'BOOTSTRAPPING', cursorGeneration: { increment: 1 } }),
      });
      expect(updates[1]?.[0]).toMatchObject({
        where: expect.objectContaining({ cursorGeneration: 1, mailboxEpoch: 1, syncState: 'BOOTSTRAPPING' }),
        data: expect.objectContaining({
          uidValidity: 7n,
          lastSeenUid: 100n,
          syncState: 'OK',
          reconcileCause: null,
        }),
      });
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ reconciled: true, detail: { boundary: 100, cursor: 100 } });
    });

    it('BACKFILL commits the probe-selected sparse UID boundary, never arithmetic boundary-N', async () => {
      stageMailboxReconcile(makeCursorBefore({ reconcileCause: 'UIDVALIDITY_CHANGED' }));
      baselineProbe.captureReconcileBaseline.mockResolvedValueOnce({
        uidValidity: 7n,
        boundary: 100,
        cursor: 94,
        selectedUids: [95, 100],
      });
      await service.reconcile(
        1,
        { mode: 'BACKFILL', expectedCursorGeneration: 0, backfillLimit: 2 },
        { staffId: 42 },
      );
      expect(baselineProbe.captureReconcileBaseline).toHaveBeenCalledWith(expect.anything(), 'BACKFILL', 2);
      expect(prisma.emailQueue.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastSeenUid: 94n, uidValidity: 7n }) }),
      );
    });

    it('returns no false success when IMAP baseline fails: queue is fail-closed and request/failure are audited', async () => {
      stageMailboxReconcile();
      baselineProbe.captureReconcileBaseline.mockRejectedValueOnce(new Error('auth failed'));
      await expect(service.reconcile(1, fromNow, { staffId: 42 })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const updates = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls;
      expect(updates[1]?.[0]).toMatchObject({
        where: expect.objectContaining({ syncState: 'BOOTSTRAPPING', cursorGeneration: 1 }),
        data: expect.objectContaining({
          syncState: 'NEEDS_RECONCILIATION',
          // Driver details are logged server-side but never persisted into operator-visible health/audit.
          lastError: expect.stringMatching(/IMAP baseline capture failed/),
        }),
      });
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledTimes(2);
    });

    it('never persists an IMAP driver or wrapped error detail into lastError/audit metadata', async () => {
      stageMailboxReconcile();
      const secret = 'imap://ops-user:secret-password@private-mail.example.test';
      baselineProbe.captureReconcileBaseline.mockRejectedValueOnce(new ServiceUnavailableException(secret));

      await expect(service.reconcile(1, fromNow, { staffId: 42 })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      const failure = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as {
        data: { lastError: string };
      };
      expect(failure.data.lastError).not.toContain(secret);
      expect(failure.data.lastError).toContain('IMAP baseline capture failed');
      const audit = (prisma.inboundAuditLog.create as ReturnType<typeof vi.fn>).mock.calls[1]?.[0] as {
        data: { metadata: { error: string } };
      };
      expect(audit.data.metadata.error).toBe('IMAP baseline capture failed');
    });

    it('RESUME_MIGRATED is permitted only for LEGACY_MIGRATION and uses a generation CAS', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: { uidValidity: '900', watermark: 512, failures: [{ uid: 500, status: 'pending' }] },
      });
      await service.reconcile(1, { mode: 'RESUME_MIGRATED', expectedCursorGeneration: 0 }, { staffId: 42 });
      expect(prisma.emailQueue.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            reconcileCause: 'LEGACY_MIGRATION',
            cursorGeneration: 0,
            mailboxEpoch: 1,
          }),
          data: expect.objectContaining({ uidValidity: 900n, lastSeenUid: 499n, syncState: 'OK' }),
        }),
      );
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledTimes(2);
    });

    it('rejects RESUME_MIGRATED after UIDVALIDITY or mailbox identity changes', async () => {
      for (const cause of ['UIDVALIDITY_CHANGED', 'MAILBOX_IDENTITY_CHANGED'] as const) {
        (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
          makeCursorBefore({ reconcileCause: cause }),
        );
        await expect(
          service.reconcile(1, { mode: 'RESUME_MIGRATED', expectedCursorGeneration: 0 }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
    });

    it('rejects healthy queue and a stale expected generation before writing an audit request', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeCursorBefore({ syncState: 'OK', reconcileCause: null }))
        .mockResolvedValueOnce(makeCursorBefore({ cursorGeneration: 2 }));
      await expect(service.reconcile(1, fromNow)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.reconcile(1, fromNow)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('concurrent reconcile loser gets 409 and writes no false requested audit row', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ count: 0 });
      await expect(service.reconcile(1, fromNow)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown queue', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.reconcile(404, fromNow)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('capture-only cannot reconcile a different queue or open its mailbox boundary', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeCursorBefore({ id: 2, mailbox: 'Shared/Operations' }),
      );

      await expect(capture.reconcile(2, fromNow, { staffId: 42 })).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
      expect(baselineProbe.captureReconcileBaseline).not.toHaveBeenCalled();
    });

    it('capture-only rejects a selected shared INBOX before BOOTSTRAPPING or IMAP access', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeCursorBefore({ id: 1, mailbox: 'INBOX' }),
      );

      await expect(capture.reconcile(1, fromNow, { staffId: 42 })).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
      expect(baselineProbe.captureReconcileBaseline).not.toHaveBeenCalled();
    });

    it('capture-only rejects Gmail All Mail and any historical BACKFILL before BOOTSTRAPPING or IMAP access', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeCursorBefore({ id: 1, mailbox: '[Gmail]/All Mail' }))
        .mockResolvedValueOnce(makeCursorBefore({ id: 1, mailbox: 'Helpdesk/Test' }));

      await expect(capture.reconcile(1, fromNow, { staffId: 42 })).rejects.toBeInstanceOf(ConflictException);
      await expect(
        capture.reconcile(
          1,
          { mode: 'BACKFILL', expectedCursorGeneration: 0, backfillLimit: 1 },
          { staffId: 42 },
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.emailQueue.updateMany).not.toHaveBeenCalled();
      expect(baselineProbe.captureReconcileBaseline).not.toHaveBeenCalled();
    });

    it('returns allowed modes from server state rather than asking the UI to infer cause', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ syncState: 'NEEDS_RECONCILIATION', reconcileCause: 'MAILBOX_IDENTITY_CHANGED' }),
      );
      await expect(service.get(1)).resolves.toMatchObject({ allowedModes: ['FROM_NOW', 'BACKFILL'] });
    });
  });

  describe('quarantine observability', () => {
    it('paginates metadata without exposing raw storage keys and returns server replay capability', async () => {
      const row = {
        id: 91,
        transport: 'IMAP',
        queueId: 2,
        messageId: '<message@example.test>',
        envelopeFrom: 'sender@example.test',
        envelopeTo: 'support@example.test',
        subject: 'Cannot connect',
        sizeBytes: 2048,
        attempts: 5,
        lastError: 'parse failed',
        truncated: true,
        rawStorageKey: 'inbound-raw/00000000-0000-4000-8000-000000000001.eml',
        createdAt: new Date('2026-07-22T12:00:00.000Z'),
        updatedAt: new Date('2026-07-22T12:01:00.000Z'),
      };
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([row]);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const out = await service.listQuarantined({ page: 1, limit: 25 });

      expect(out).toMatchObject({ total: 1, page: 1, limit: 25 });
      expect(out.items[0]).toMatchObject({ id: 91, replayAllowed: false });
      expect(out.items[0]).not.toHaveProperty('rawStorageKey');
      const args = (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        select: Record<string, boolean>;
      };
      expect(args.select).not.toHaveProperty('rawStorageKey');
    });

    it('searches both legacy and observed Message-ID values', async () => {
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listQuarantined({ page: 1, limit: 25, messageId: '<thread@example.test>' });

      const args = (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        where: { OR?: unknown[] };
      };
      expect(args.where.OR).toEqual([
        { messageId: { contains: '<thread@example.test>', mode: 'insensitive' } },
        { observedMessageId: { contains: '<thread@example.test>', mode: 'insensitive' } },
      ]);
    });

    it('returns a safe audit timeline without opaque audit JSON or a raw storage key', async () => {
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 92,
        state: 'QUARANTINED',
        transport: 'PIPE',
        queueId: 3,
        messageId: null,
        envelopeFrom: null,
        envelopeTo: 'pipe@example.test',
        subject: '',
        sizeBytes: 1024,
        attempts: 1,
        lastError: 'bad MIME',
        truncated: false,
        rawStorageKey: 'inbound-raw/00000000-0000-4000-8000-000000000001.eml',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      (prisma.inboundAuditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 1,
          actorStaffId: null,
          actorEmail: 'system',
          action: 'mail.quarantined',
          reason: 'bad MIME',
          metadata: { rawStorageKey: 'inbound-raw/secret.eml' },
          createdAt: new Date(),
        },
      ]);

      const out = await service.getQuarantined(92);

      expect(out.delivery).toMatchObject({ id: 92, replayAllowed: true, replayBlockReason: null });
      expect(out.delivery).not.toHaveProperty('rawStorageKey');
      expect(out.audit[0]).not.toHaveProperty('metadata');
      const args = (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        select: Record<string, boolean>;
      };
      expect(args.select).not.toHaveProperty('rawStorageKey');
      const auditArgs = (prisma.inboundAuditLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        select: Record<string, boolean>;
      };
      expect(auditArgs.select).not.toHaveProperty('metadata');
    });
  });

  describe('replayQuarantined', () => {
    const replayDto = {
      reason: 'fixed mailbox rule',
      expectedUpdatedAt: new Date('2026-07-22T12:00:00.000Z'),
    };
    const actor = { staffId: 7, email: 'ops@example.test' };

    it('resets a QUARANTINED delivery back to ACCEPTED with a durable reason audit', async () => {
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'QUARANTINED',
        truncated: false,
        updatedAt: replayDto.expectedUpdatedAt,
      });
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      await expect(service.replayQuarantined(9, replayDto, actor)).resolves.toEqual({ replayed: true });
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              { id: 9, state: 'QUARANTINED', updatedAt: replayDto.expectedUpdatedAt },
              { NOT: { queue: { is: { captureRetiredAt: { not: null } } } } },
            ]),
          },
          data: expect.objectContaining({ state: 'ACCEPTED', attempts: 0 }),
        }),
      );
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'mail.quarantine_replay',
            deliveryId: 9,
            reason: 'fixed mailbox rule',
            actorStaffId: 7,
          }),
        }),
      );
    });

    it('capture-only refuses quarantine replay before it reads, requeues, or audits any legacy delivery', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_OUTBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );

      await expect(capture.replayQuarantined(9, replayDto, actor)).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('refuses replay from a capture-retired queue even when an in-memory caller would otherwise accept the CAS', async () => {
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'QUARANTINED',
        queueId: 3,
        truncated: false,
        updatedAt: replayDto.expectedUpdatedAt,
      });
      // The queue-row lock is the authoritative lifecycle fence. This deliberately makes the
      // mocked transition look successful: removing the lock would turn this test false-green.
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 3, captureRetiredAt: new Date('2026-07-23T11:00:00.000Z') },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await expect(service.replayQuarantined(9, replayDto, actor)).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the delivery is not quarantined', async () => {
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.replayQuarantined(9, replayDto, actor)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects stale/concurrent replay with 409 and does not create a false audit row', async () => {
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'QUARANTINED',
        truncated: false,
        updatedAt: new Date('2026-07-22T12:00:01.000Z'),
      });
      await expect(service.replayQuarantined(9, replayDto, actor)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('never replays truncated raw MIME as a partial ticket', async () => {
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'QUARANTINED',
        truncated: true,
        updatedAt: replayDto.expectedUpdatedAt,
      });
      await expect(service.replayQuarantined(9, replayDto, actor)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('captured inbound operator API', () => {
    const expectedUpdatedAt = new Date('2026-07-23T12:00:00.000Z');
    const promoteDto = {
      reason: 'Capture-only verification passed; release to the normal inbound drain',
      expectedUpdatedAt,
    };
    const actor = { staffId: 7, email: 'ops@example.test', isAdmin: true };

    const captureReadyService = () =>
      new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_IMAP_ENABLED: false,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: false,
          TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
          TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 3,
          TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 95,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );

    it('lists captured metadata without raw MIME or opaque storage keys', async () => {
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 93,
          transport: 'IMAP',
          queueId: 2,
          messageId: '<capture@example.test>',
          observedMessageId: '<capture@example.test>',
          envelopeFrom: 'sender@example.test',
          envelopeTo: 'noc@example.test',
          subject: 'Captured test',
          sizeBytes: 2048,
          attempts: 0,
          lastError: null,
          truncated: false,
          rawMime: Buffer.from('secret mime'),
          rawStorageKey: 'inbound-raw/secret.eml',
          createdAt: expectedUpdatedAt,
          updatedAt: expectedUpdatedAt,
        },
      ]);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const out = await service.listCaptured({ page: 1, limit: 25 });

      expect(out.items[0]).toMatchObject({ id: 93, promoteAllowed: true, promoteBlockReason: null });
      expect(out.items[0]).not.toHaveProperty('rawMime');
      expect(out.items[0]).not.toHaveProperty('rawStorageKey');
      const args = (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        where: { state: string };
        select: Record<string, boolean>;
      };
      expect(args.where.state).toBe('CAPTURED');
      expect(args.select).not.toHaveProperty('rawMime');
      expect(args.select).not.toHaveProperty('rawStorageKey');
    });

    it('scopes captured listings to the operator department exactly like quarantine', async () => {
      (prisma.departmentStaff.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ departmentId: 41 }]);
      (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listCaptured({ page: 1, limit: 25 }, { staffId: 8, isAdmin: false });

      const args = (prisma.inboundDelivery.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        where: { AND: Array<{ state?: string } | { OR?: unknown[] }> };
      };
      expect(args.where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: 'CAPTURED' }),
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                effectiveOwnerKind: { in: ['RECEIVING', 'ROUTED'] },
                effectiveOwnerDepartmentId: { in: [41] },
              }),
              expect.objectContaining({
                effectiveOwnerKind: 'TICKET',
                effectiveOwnerTicket: { is: { departmentId: { in: [41] } } },
              }),
            ]),
          }),
        ]),
      );
    });

    it('returns captured detail/audit metadata without raw MIME, storage keys, or audit JSON', async () => {
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 94,
        state: 'CAPTURED',
        transport: 'PIPE',
        queueId: 3,
        messageId: null,
        observedMessageId: null,
        envelopeFrom: null,
        envelopeTo: 'noc@example.test',
        subject: 'Capture',
        sizeBytes: 1024,
        attempts: 0,
        lastError: null,
        truncated: false,
        rawMime: Buffer.from('secret mime'),
        rawStorageKey: 'inbound-raw/secret.eml',
        createdAt: expectedUpdatedAt,
        updatedAt: expectedUpdatedAt,
      });
      (prisma.inboundAuditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        {
          id: 12,
          action: 'mail.captured',
          reason: 'Capture-only enabled',
          metadata: { rawStorageKey: 'inbound-raw/secret.eml' },
          createdAt: expectedUpdatedAt,
        },
      ]);

      const out = await service.getCaptured(94);

      expect(out.delivery).toMatchObject({ id: 94, promoteAllowed: true, promoteBlockReason: null });
      expect(out.delivery).not.toHaveProperty('rawMime');
      expect(out.delivery).not.toHaveProperty('rawStorageKey');
      expect(out.audit[0]).not.toHaveProperty('metadata');
      const args = (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        select: Record<string, boolean>;
      };
      expect(args.select).not.toHaveProperty('rawMime');
      expect(args.select).not.toHaveProperty('rawStorageKey');
    });

    it('atomically promotes CAPTURED -> ACCEPTED with a durable reason audit', async () => {
      const ops = captureReadyService();
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'CAPTURED',
        queueId: 3,
        truncated: false,
        updatedAt: expectedUpdatedAt,
      });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 3, captureRetiredAt: new Date('2026-07-23T11:00:00.000Z') },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await expect(ops.promoteCaptured(95, promoteDto, actor)).resolves.toEqual({ promoted: true });

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            AND: expect.arrayContaining([
              {
                id: 95,
                queueId: 3,
                state: 'CAPTURED',
                updatedAt: expectedUpdatedAt,
              },
              { queue: { is: { captureRetiredAt: { not: null } } } },
            ]),
          },
          data: expect.objectContaining({
            state: 'ACCEPTED',
            capturePromotedAt: expect.any(Date),
            attempts: 0,
            lastError: null,
            nextAttemptAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
          }),
        }),
      );
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'mail.capture_promoted',
            deliveryId: 95,
            reason: promoteDto.reason,
            actorStaffId: 7,
            metadata: { expectedUpdatedAt: expectedUpdatedAt.toISOString() },
          }),
        }),
      );
    });

    it('normal inbound canary refuses a different captured delivery before any state or audit write', async () => {
      const scoped = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: false,
          TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 3,
          TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 96,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );

      await expect(scoped.promoteCaptured(95, promoteDto, actor)).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('normal inbound canary accepts only its selected delivery in its selected queue', async () => {
      const scoped = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: false,
          TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 3,
          TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 95,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'CAPTURED',
        queueId: 3,
        truncated: false,
        updatedAt: expectedUpdatedAt,
      });
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 3, captureRetiredAt: new Date('2026-07-23T11:00:00.000Z') },
      ]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await expect(scoped.promoteCaptured(95, promoteDto, actor)).resolves.toEqual({ promoted: true });

      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.inboundAuditLog.create).toHaveBeenCalledTimes(1);
    });

    it('refuses promotion unless the selected delivery is locked to a capture-retired queue', async () => {
      const ops = captureReadyService();
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'CAPTURED',
        queueId: 3,
        truncated: false,
        updatedAt: expectedUpdatedAt,
      });
      // Do not make updateMany enforce the predicate itself: the queue-row lock must reject
      // this stale/non-capture queue before any durable state transition can happen.
      (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 3, captureRetiredAt: null }]);
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await expect(ops.promoteCaptured(95, promoteDto, actor)).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('normal inbound canary rejects its selected delivery if it belongs to another queue', async () => {
      const scoped = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: false,
          TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: 3,
          TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: 95,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'CAPTURED',
        queueId: 4,
        truncated: false,
        updatedAt: expectedUpdatedAt,
      });

      await expect(scoped.promoteCaptured(95, promoteDto, actor)).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('requires normal delivery enabled and capture-only disabled before any promotion write', async () => {
      for (const config of [
        {
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: false,
        },
        {
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
        },
      ]) {
        const blocked = new EmailQueueService(
          prisma as unknown as PrismaService,
          undefined,
          undefined,
          config as never,
          undefined,
          new MailAccessPolicy(prisma as unknown as PrismaService),
        );
        await expect(blocked.promoteCaptured(95, promoteDto, actor)).rejects.toBeInstanceOf(
          ConflictException,
        );
      }
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('rejects a stale capture version with no false audit row', async () => {
      const ops = captureReadyService();
      (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        state: 'CAPTURED',
        truncated: false,
        updatedAt: new Date('2026-07-23T12:00:01.000Z'),
      });

      await expect(ops.promoteCaptured(95, promoteDto, actor)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.inboundDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.inboundAuditLog.create).not.toHaveBeenCalled();
    });

    it('rejects invalid promotion DTOs without an operator reason or row version', () => {
      expect(PromoteCapturedInboundSchema.safeParse({ expectedUpdatedAt }).success).toBe(false);
      expect(PromoteCapturedInboundSchema.safeParse({ reason: promoteDto.reason }).success).toBe(false);
    });
  });

  describe('health', () => {
    it('reports the selected capture scope/cap and warns if an IMAP capture queue still points at shared INBOX', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_IMAP_ENABLED: true,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
          TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({ id: 1, mailbox: 'INBOX', isEnabled: false }),
      ]);

      const out = await capture.health(new Date('2026-07-23T12:00:00.000Z'));

      expect(out).toMatchObject({
        captureOnly: true,
        normalInboundDeliveryEnabled: false,
        captureQueueId: 1,
        captureMaxMessages: 1,
        captureTarget: { queueId: 1, ready: false },
      });
      expect(out.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'capture_mailbox_unsafe' })]),
      );
    });

    it('marks capture as not ready when its configured target is missing, disabled, or not a healthy baseline', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_IMAP_ENABLED: true,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
          TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      const findMany = prisma.emailQueue.findMany as ReturnType<typeof vi.fn>;

      findMany.mockResolvedValueOnce([]);
      const missing = await capture.health(new Date('2026-07-23T12:00:00.000Z'));
      expect(missing.captureTarget).toMatchObject({ queueId: null, ready: false });
      expect(missing.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'capture_target_not_ready' })]),
      );

      findMany.mockResolvedValueOnce([makeSafeQueue({ id: 1, mailbox: 'Helpdesk/Test', isEnabled: false })]);
      const disabled = await capture.health(new Date('2026-07-23T12:00:00.000Z'));
      expect(disabled.captureTarget).toMatchObject({
        queueId: 1,
        ready: false,
        reason: expect.stringMatching(/disabled/i),
      });

      findMany.mockResolvedValueOnce([
        makeSafeQueue({
          id: 1,
          mailbox: 'Helpdesk/Test',
          isEnabled: true,
          syncState: 'BOOTSTRAPPING',
          uidValidity: null,
        }),
      ]);
      const baselinePending = await capture.health(new Date('2026-07-23T12:00:00.000Z'));
      expect(baselinePending.captureTarget).toMatchObject({
        queueId: 1,
        ready: false,
        reason: expect.stringMatching(/baseline/i),
      });
    });

    it('marks capture not-ready when the selected credential-bearing IMAP queue is not TLS enabled', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_IMAP_ENABLED: true,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
          TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({ id: 1, mailbox: 'Helpdesk/Test', isEnabled: true, uidValidity: 77n, useTls: false }),
      ]);

      const out = await capture.health(new Date('2026-07-23T12:00:00.000Z'));

      expect(out.captureTarget).toMatchObject({
        queueId: 1,
        ready: false,
        reason: expect.stringMatching(/TLS/i),
      });
      expect(out.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'capture_target_not_ready' })]),
      );
    });

    it('marks capture ready only after the enabled dedicated IMAP queue has a healthy UIDVALIDITY baseline and live runtime proof', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_IMAP_ENABLED: true,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
          TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({
          id: 1,
          mailbox: 'Helpdesk/Test',
          isEnabled: true,
          uidValidity: 77n,
          captureRetiredAt: new Date('2026-07-23T11:00:00.000Z'),
        }),
      ]);

      const out = await capture.health(new Date('2026-07-23T12:00:00.000Z'));

      expect(out.captureTarget).toEqual({ queueId: 1, ready: true, reason: null });
      expect(out.alerts.some((alert) => alert.kind === 'capture_target_not_ready')).toBe(false);
      expect(prisma.emailQueue.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ useTls: true }) }),
      );
    });

    it('keeps a healthy-looking capture target not-ready until its durable retirement marker exists', async () => {
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_IMAP_ENABLED: true,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
          TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({ id: 1, mailbox: 'Helpdesk/Test', isEnabled: true, uidValidity: 77n }),
      ]);

      const out = await capture.health(new Date('2026-07-23T12:00:00.000Z'));

      expect(out.captureTarget).toMatchObject({
        queueId: 1,
        ready: false,
        reason: expect.stringMatching(/durably armed/i),
      });
      expect(out.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'capture_target_not_ready' })]),
      );
    });

    it('keeps capture not-ready until this process has verified the live dedicated folder', async () => {
      (baselineProbe.isCaptureQueueReady as ReturnType<typeof vi.fn>).mockReturnValue(false);
      const capture = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        baselineProbe as unknown as import('./inbound.service').InboundMailService,
        {
          TELECOM_HD_IMAP_ENABLED: true,
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: true,
          TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: 1,
          TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES: 1,
          TELECOM_HD_INBOUND_MAX_SIZE_MB: 35,
          TELECOM_HD_FIELD_ENCRYPTION_KEY: TEST_FIELD_ENCRYPTION_KEY,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({
          id: 1,
          mailbox: 'Helpdesk/Test',
          isEnabled: true,
          uidValidity: 77n,
          captureRetiredAt: new Date('2026-07-23T11:00:00.000Z'),
        }),
      ]);

      const out = await capture.health(new Date('2026-07-23T12:00:00.000Z'));

      expect(out.captureTarget).toMatchObject({
        queueId: 1,
        ready: false,
        reason: expect.stringMatching(/not yet verified/i),
      });
      expect(out.alerts).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'capture_target_not_ready' })]),
      );
    });

    it('reports backlog + byState and raises halt / quarantine / stalled alerts', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({ id: 1, isEnabled: true, syncState: 'NEEDS_RECONCILIATION' }),
        makeSafeQueue({ id: 2, isEnabled: true, syncState: 'OK' }),
      ]);
      (prisma.inboundDelivery.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
        { state: 'ACCEPTED', _count: { _all: 3 } },
        { state: 'RETRY', _count: { _all: 2 } },
        { state: 'QUARANTINED', _count: { _all: 1 } },
        { state: 'PROCESSED', _count: { _all: 10 } },
      ]);
      (prisma.inboundDelivery.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(4); // stalled PROCESSING
      (prisma.inboundAuditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const out = await service.health(new Date('2026-07-18T12:00:00.000Z'));

      expect(out.ledger.backlog).toBe(5); // accepted 3 + retry 2
      expect(out.ledger.byState).toMatchObject({ accepted: 3, retry: 2, quarantined: 1, processed: 10 });
      expect(out.ledger.stalledProcessing).toBe(4);
      const kinds = out.alerts.map((a) => a.kind);
      expect(kinds).toContain('queue_halted');
      expect(kinds).toContain('quarantine');
      expect(kinds).toContain('stalled_processing');
      expect(kinds).toContain('inbound_collision');
      expect(out.alerts.find((a) => a.kind === 'queue_halted')?.severity).toBe('critical');
    });

    it('raises an aged-backlog alert when the oldest pending delivery is over 15 min old', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundDelivery.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
        { state: 'ACCEPTED', _count: { _all: 1 } },
      ]);
      (prisma.inboundDelivery.findFirst as ReturnType<typeof vi.fn>).mockImplementation(
        ({ where }: { where: { state: unknown } }) =>
          JSON.stringify(where.state).includes('ACCEPTED')
            ? Promise.resolve({
                id: 7,
                createdAt: new Date('2026-07-18T11:40:00.000Z'),
                nextAttemptAt: null,
                attempts: 0,
              })
            : Promise.resolve(null),
      );
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      const out = await service.health(new Date('2026-07-18T12:00:00.000Z')); // 20 min later
      expect(out.alerts.map((a) => a.kind)).toContain('aged_backlog');
    });

    it('reports a clean bill of health (no alerts) when idle', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([makeSafeQueue({ id: 1 })]);
      const out = await service.health(new Date('2026-07-18T12:00:00.000Z'));
      expect(out.alerts).toEqual([]);
      expect(out.ledger.backlog).toBe(0);
    });

    it('surfaces enabled IMAP that is disabled globally, never connected and stale', async () => {
      const ops = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        undefined,
        {
          TELECOM_HD_IMAP_ENABLED: false,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({
          id: 4,
          isEnabled: true,
          lastConnectedAt: null,
          lastConnectionErrorAt: new Date('2026-07-22T11:00:00.000Z'),
          lastPollStartedAt: new Date('2026-07-22T11:00:00.000Z'),
          lastPollCompletedAt: null,
        } as never),
      ]);
      const out = await ops.health(new Date('2026-07-22T12:00:00.000Z'));
      const kinds = out.alerts.map((alert) => alert.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(['imap_disabled', 'never_connected', 'connection_error', 'poll_running']),
      );
    });

    it('keeps the operator health/recovery surface available while the shared delivery gate is closed', async () => {
      const ops = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        undefined,
        {
          TELECOM_HD_INBOUND_DELIVERY_ENABLED: false,
          TELECOM_HD_IMAP_ENABLED: false,
        } as never,
        undefined,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const out = await ops.health(new Date('2026-07-22T12:00:00.000Z'));

      expect(out.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'inbound_delivery_disabled', severity: 'critical' }),
        ]),
      );
      expect(out.ledger.byState).toEqual(expect.objectContaining({ accepted: 0, retry: 0 }));
    });

    it('alerts when a reconcile request remains BOOTSTRAPPING even before a poll timestamp exists', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({
          id: 7,
          isEnabled: true,
          syncState: 'BOOTSTRAPPING',
          reconcileRequestedAt: new Date('2026-07-22T11:40:00.000Z'),
          lastPollStartedAt: null,
        }),
      ]);

      const out = await service.health(new Date('2026-07-22T12:00:00.000Z'));

      expect(out.alerts.map((alert) => alert.kind)).toContain('bootstrap_stalled');
    });

    it('reports quarantine bytes and warns before raw storage reaches its write reserve', async () => {
      const rawStorage = {
        capacity: vi.fn().mockResolvedValue({
          reserveBytes: 100n * 1024n * 1024n,
          availableBytes: 101n * 1024n * 1024n,
        }),
      };
      const ops = new EmailQueueService(
        prisma as unknown as PrismaService,
        undefined,
        undefined,
        { TELECOM_HD_IMAP_ENABLED: true, TELECOM_HD_INBOUND_MAX_SIZE_MB: 35 } as never,
        rawStorage as never,
        new MailAccessPolicy(prisma as unknown as PrismaService),
      );
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.inboundDelivery.aggregate as ReturnType<typeof vi.fn>).mockResolvedValue({
        _sum: { sizeBytes: 4096 },
      });

      const out = await ops.health(new Date('2026-07-22T12:00:00.000Z'));

      expect(out.ledger.quarantineBytes).toBe(4096);
      expect(out.rawStorage).toEqual({
        availableBytes: String(101n * 1024n * 1024n),
        reserveBytes: String(100n * 1024n * 1024n),
        nearReserve: true,
      });
      expect(out.alerts.map((alert) => alert.kind)).toContain('raw_storage_near_reserve');
    });
  });

  describe('ReconcileEmailQueueSchema (cutover gates)', () => {
    it('requires expectedCursorGeneration for every reconcile request', () => {
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'RESUME_MIGRATED' }).success).toBe(false);
      expect(
        ReconcileEmailQueueSchema.safeParse({ mode: 'RESUME_MIGRATED', expectedCursorGeneration: 0 }).success,
      ).toBe(true);
    });

    it('rejects FROM_NOW without confirm + reason (the discard safety gate)', () => {
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'FROM_NOW' }).success).toBe(false);
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'FROM_NOW', confirm: true }).success).toBe(false);
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'FROM_NOW', reason: 'x' }).success).toBe(false);
      expect(
        ReconcileEmailQueueSchema.safeParse({
          mode: 'FROM_NOW',
          expectedCursorGeneration: 0,
          confirm: true,
          reason: 'clean cutover',
        }).success,
      ).toBe(true);
    });

    it('rejects BACKFILL without a positive backfillLimit (else it silently equals FROM_NOW)', () => {
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'BACKFILL' }).success).toBe(false);
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'BACKFILL', backfillLimit: 0 }).success).toBe(false);
      expect(
        ReconcileEmailQueueSchema.safeParse({
          mode: 'BACKFILL',
          expectedCursorGeneration: 0,
          backfillLimit: 500,
        }).success,
      ).toBe(true);
    });
  });

  describe('ReplayQuarantinedInboundSchema', () => {
    it('requires an explicit reason and an inspected row version', () => {
      expect(ReplayQuarantinedInboundSchema.safeParse({}).success).toBe(false);
      expect(ReplayQuarantinedInboundSchema.safeParse({ reason: 'why' }).success).toBe(false);
      expect(
        ReplayQuarantinedInboundSchema.safeParse({
          reason: 'verified the root cause',
          expectedUpdatedAt: '2026-07-22T12:00:00.000Z',
        }).success,
      ).toBe(true);
    });
  });
});
