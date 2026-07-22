import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EmailQueueService } from './email-queue.service';
import { ReconcileEmailQueueSchema, ReplayQuarantinedInboundSchema } from './dto';
import type { PrismaService } from '../../prisma/prisma.service';

// ─── helpers ────────────────────────────────────────────────────────────────

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
    departmentId: null,
    signature: '',
    isEnabled: false,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    syncState: 'OK',
    lastError: null,
    lastSeenUid: 0n,
    uidValidity: null,
    cursorGeneration: 0,
    mailboxEpoch: 1,
    reconcileCause: null,
    reconcileRequestedAt: null,
    bootstrapPolicy: null,
    bootstrapBackfillLimit: null,
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
  departmentId: number | null;
  signature: string;
  isEnabled: boolean;
  createdAt: Date;
  syncState: 'OK' | 'BOOTSTRAPPING' | 'NEEDS_RECONCILIATION';
  lastError: string | null;
  lastSeenUid: bigint;
  uidValidity: bigint | null;
  cursorGeneration: number;
  mailboxEpoch: number;
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
  const prisma = {
    emailQueue: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
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
  } as unknown as Record<string, unknown>;
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
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('EmailQueueService', () => {
  let service: EmailQueueService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let baselineProbe: { captureReconcileBaseline: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    prisma = makePrismaMock();
    baselineProbe = {
      captureReconcileBaseline: vi.fn().mockResolvedValue({
        uidValidity: 7n,
        boundary: 100,
        cursor: 100,
        selectedUids: [],
      }),
    };
    service = new EmailQueueService(
      prisma as unknown as PrismaService,
      undefined,
      baselineProbe as unknown as import('./inbound.service').InboundMailService,
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

      // Prisma was called with passwordEnc (may be encrypted or plain depending on env), not password
      const createCall = (prisma.emailQueue.create as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown>; select: Record<string, boolean> },
      ];
      // passwordEnc must be set (either plain or encrypted)
      expect(createCall[0].data).toHaveProperty('passwordEnc');
      expect(typeof createCall[0].data['passwordEnc']).toBe('string');
      expect(createCall[0].data).not.toHaveProperty('password');
      expect(createCall[0].select).not.toHaveProperty('passwordEnc');
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
  });

  // ── update ────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('maps password → passwordEnc when provided', async () => {
      const existing = makeSafeQueue({ id: 3 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await service.update(3, { password: 'newPass' });

      const updateCall = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ];
      // passwordEnc must be set (either plain or encrypted)
      expect(updateCall[0].data).toHaveProperty('passwordEnc');
      expect(typeof updateCall[0].data['passwordEnc']).toBe('string');
      expect(updateCall[0].data).not.toHaveProperty('password');
      expect(updateCall[0].where).toMatchObject({ mailboxEpoch: 1, cursorGeneration: 0 });
    });

    it('does not touch passwordEnc when password not in dto', async () => {
      const existing = makeSafeQueue({ id: 3 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await service.update(3, { isEnabled: true });

      const updateCall = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(updateCall[0].data).not.toHaveProperty('passwordEnc');
      expect(updateCall[0].data).not.toHaveProperty('password');
    });

    it('throws NotFoundException when queue does not exist', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.update(999, { isEnabled: true })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('identity guard: a host change on a bootstrapped IMAP queue resets the cursor + halts', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, type: 'IMAP', host: 'old.example.com', uidValidity: 42n }),
      );

      await service.update(3, { host: 'new.example.com' });

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

    it('identity guard: a password-only change never resets the cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, type: 'IMAP', uidValidity: 42n }),
      );

      await service.update(3, { password: 'rotated' });

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

      await service.update(3, { host: 'new.example.com' });

      const call = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).toMatchObject({
        syncState: 'NEEDS_RECONCILIATION',
        mailboxEpoch: { increment: 1 },
        reconcileCause: 'MAILBOX_IDENTITY_CHANGED',
      });
    });

    it('identity CAS retry prevents a stale full-form update from reverting host without a new epoch', async () => {
      const old = makeSafeQueue({ id: 3, host: 'imap-a.example', mailboxEpoch: 1, cursorGeneration: 4 });
      const concurrent = makeSafeQueue({
        id: 3,
        host: 'imap-b.example',
        mailboxEpoch: 2,
        cursorGeneration: 5,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(old)
        .mockResolvedValueOnce(concurrent)
        .mockResolvedValueOnce(concurrent);
      (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ count: 0 }) // another operator committed A→B first
        .mockResolvedValueOnce({ count: 1 });

      await service.update(3, { host: 'imap-a.example' });

      const calls = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0]?.[0]).toMatchObject({
        where: expect.objectContaining({ host: 'imap-a.example', mailboxEpoch: 1 }),
      });
      expect(calls[1]?.[0]).toMatchObject({
        where: expect.objectContaining({ host: 'imap-b.example', mailboxEpoch: 2, cursorGeneration: 5 }),
        data: expect.objectContaining({
          host: 'imap-a.example',
          mailboxEpoch: { increment: 1 },
          cursorGeneration: { increment: 1 },
        }),
      });
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
        uidValidity: null,
      });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(imap)
        .mockResolvedValueOnce(pipe)
        .mockResolvedValueOnce(pipe)
        .mockResolvedValueOnce(imap);
      await service.update(3, { type: 'PIPE' });
      await service.update(3, { type: 'IMAP' });
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

      await expect(service.delete(1)).resolves.toBeUndefined();
      expect(prisma.emailQueue.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when queue does not exist', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.delete(404)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.emailQueue.delete).not.toHaveBeenCalled();
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
        expect.objectContaining({ id: 1, mailboxEpoch: 1, cursorGeneration: 1 }),
        'FROM_NOW',
        0,
      );
      const updates = (prisma.emailQueue.updateMany as ReturnType<typeof vi.fn>).mock.calls;
      expect(updates[0]?.[0]).toMatchObject({
        where: expect.objectContaining({
          cursorGeneration: 0,
          mailboxEpoch: 1,
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

    it('returns detail/audit metadata but never a raw storage key', async () => {
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
      (prisma.inboundAuditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      const out = await service.getQuarantined(92);

      expect(out.delivery).toMatchObject({ id: 92, replayAllowed: true, replayBlockReason: null });
      expect(out.delivery).not.toHaveProperty('rawStorageKey');
      const args = (prisma.inboundDelivery.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        select: Record<string, boolean>;
      };
      expect(args.select).not.toHaveProperty('rawStorageKey');
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
          where: { id: 9, state: 'QUARANTINED', updatedAt: replayDto.expectedUpdatedAt },
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

  describe('health', () => {
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
      const ops = new EmailQueueService(prisma as unknown as PrismaService, undefined, undefined, {
        TELECOM_HD_IMAP_ENABLED: false,
      } as never);
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
