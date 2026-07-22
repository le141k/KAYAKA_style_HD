import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
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
    bootstrapPolicy: null,
    bootstrapBackfillLimit: null,
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
  syncState: 'OK' | 'NEEDS_RECONCILIATION';
  lastError: string | null;
  lastSeenUid: bigint;
  uidValidity: bigint | null;
  cursorGeneration: number;
  bootstrapPolicy: 'FROM_NOW' | 'BACKFILL' | null;
  bootstrapBackfillLimit: number | null;
};

function makePrismaMock() {
  const prisma = {
    emailQueue: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
  };
  const transaction = {
    inboundDelivery: prisma.inboundDelivery,
    inboundAuditLog: prisma.inboundAuditLog,
  };
  return {
    ...prisma,
    $transaction: vi.fn(async (input: unknown) => {
      if (typeof input === 'function') {
        return (input as (tx: typeof transaction) => Promise<unknown>)(transaction);
      }
      return Promise.all(input as Promise<unknown>[]);
    }),
  } as unknown as PrismaService;
}

/** The projection the reconcile `before` snapshot reads (now includes `type` for the
 *  IMAP-only guard). */
function makeCursorBefore(overrides: Record<string, unknown> = {}) {
  return {
    type: 'IMAP',
    uidValidity: null,
    lastSeenUid: 0n,
    syncState: 'OK',
    cursorGeneration: 0,
    ...overrides,
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('EmailQueueService', () => {
  let service: EmailQueueService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new EmailQueueService(prisma as unknown as PrismaService);
  });

  // ── list ──────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns an array of queues', async () => {
      const rows = [makeSafeQueue({ id: 1 }), makeSafeQueue({ id: 2 })];
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(rows);

      const result = await service.list();

      expect(result).toEqual(rows);
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

      expect(result).toEqual(row);
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
  });

  // ── update ────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('maps password → passwordEnc when provided', async () => {
      const existing = makeSafeQueue({ id: 3 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await service.update(3, { password: 'newPass' });

      const updateCall = (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { where: { id: number }; data: Record<string, unknown>; select: Record<string, boolean> },
      ];
      // passwordEnc must be set (either plain or encrypted)
      expect(updateCall[0].data).toHaveProperty('passwordEnc');
      expect(typeof updateCall[0].data['passwordEnc']).toBe('string');
      expect(updateCall[0].data).not.toHaveProperty('password');
      expect(updateCall[0].select).not.toHaveProperty('passwordEnc');
    });

    it('does not touch passwordEnc when password not in dto', async () => {
      const existing = makeSafeQueue({ id: 3 });
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

      await service.update(3, { isEnabled: true });

      const updateCall = (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mock.calls[0] as [
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
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());

      await service.update(3, { host: 'new.example.com' });

      const call = (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).toMatchObject({
        host: 'new.example.com',
        uidValidity: null,
        lastSeenUid: 0n,
        syncState: 'NEEDS_RECONCILIATION',
        cursorGeneration: { increment: 1 },
      });
    });

    it('identity guard: a password-only change never resets the cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, type: 'IMAP', uidValidity: 42n }),
      );
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());

      await service.update(3, { password: 'rotated' });

      const call = (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).not.toHaveProperty('uidValidity');
      expect(call[0].data).not.toHaveProperty('syncState');
    });

    it('identity guard: an identity change on a never-bootstrapped queue does NOT reset (no cursor yet)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeSafeQueue({ id: 3, type: 'IMAP', host: 'old.example.com', uidValidity: null }),
      );
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());

      await service.update(3, { host: 'new.example.com' });

      const call = (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call[0].data).not.toHaveProperty('syncState');
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
    it('FROM_NOW: discards the cursor, bumps generation, records a per-queue FROM_NOW intent', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());
      await service.reconcile(
        1,
        { mode: 'FROM_NOW', confirm: true, reason: 'clean cutover' },
        { staffId: 42 },
      );
      expect(prisma.emailQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            // BOOTSTRAPPING (not OK) until the poller fixes the high-water baseline.
            syncState: 'BOOTSTRAPPING',
            uidValidity: null,
            lastSeenUid: 0n,
            cursorGeneration: { increment: 1 },
            bootstrapPolicy: 'FROM_NOW',
          }),
        }),
      );
    });

    it('BACKFILL: records a per-queue BACKFILL intent + limit for the next bootstrap', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());
      await service.reconcile(1, { mode: 'BACKFILL', backfillLimit: 250 }, { staffId: 42 });
      expect(prisma.emailQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ bootstrapPolicy: 'BACKFILL', bootstrapBackfillLimit: 250 }),
        }),
      );
    });

    it('RESUME_MIGRATED: carries state:<id> UIDVALIDITY + watermark forward onto the ledger cursor', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: { uidValidity: '900', watermark: 512, failures: [] },
      });
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());
      await service.reconcile(1, { mode: 'RESUME_MIGRATED' }, { staffId: 42 });
      expect(prisma.emailQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            uidValidity: 900n,
            lastSeenUid: 512n,
            syncState: 'OK',
            cursorGeneration: { increment: 1 },
          }),
        }),
      );
    });

    it('RESUME_MIGRATED: rewinds the cursor below the lowest still-pending UID', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        value: {
          uidValidity: '900',
          watermark: 512,
          failures: [
            { uid: 500, status: 'pending', attempts: 1, lastFailedAt: 'x' },
            { uid: 480, status: 'quarantined', attempts: 3, lastFailedAt: 'x' },
          ],
        },
      });
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());
      await service.reconcile(1, { mode: 'RESUME_MIGRATED' }, { staffId: 42 });
      // pending uid 500 → resume cursor rewound to 499 so it is re-fetched (idempotent).
      expect(prisma.emailQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastSeenUid: 499n }) }),
      );
    });

    it('RESUME_MIGRATED: falls back to the bare lastSeenUid:<id> but REFUSES it (no UIDVALIDITY)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null) // state:<id> absent
        .mockResolvedValueOnce({ value: 400 }); // legacy bare watermark
      // Assert the SPECIFIC refusal path (no UIDVALIDITY) AND the exception type — a
      // BadRequestException so the controller returns 400, not 500. Call reconcile once
      // (the setting mock is a two-shot mockResolvedValueOnce) and inspect the error.
      const err = await service
        .reconcile(1, { mode: 'RESUME_MIGRATED' }, { staffId: 42 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toMatch(/no UIDVALIDITY/i);
      expect(prisma.emailQueue.update).not.toHaveBeenCalled();
    });

    it('RESUME_MIGRATED: refuses when no legacy cursor exists at all', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const err = await service
        .reconcile(1, { mode: 'RESUME_MIGRATED' }, { staffId: 42 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toMatch(/No legacy IMAP cursor found/i);
      expect(prisma.emailQueue.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown queue', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(
        service.reconcile(404, { mode: 'FROM_NOW', confirm: true, reason: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses to reconcile a non-IMAP queue (no UID space to stamp a cursor onto)', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        makeCursorBefore({ type: 'PIPE' }),
      );
      const err = await service
        .reconcile(1, { mode: 'FROM_NOW', confirm: true, reason: 'x' }, { staffId: 42 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toMatch(/only.*IMAP/i);
      expect(prisma.emailQueue.update).not.toHaveBeenCalled();
    });

    it('writes a durable audit row (actor + reason + before/after) when an audit sink is wired', async () => {
      const audit = { log: vi.fn().mockResolvedValue(undefined) };
      const svc = new EmailQueueService(
        prisma as unknown as PrismaService,
        audit as unknown as import('./inbound-audit.service').InboundAuditService,
      );
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.emailQueue.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeSafeQueue());
      await svc.reconcile(
        1,
        { mode: 'FROM_NOW', confirm: true, reason: 'planned cutover' },
        {
          staffId: 42,
          email: 'ops@example.com',
        },
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'mail.reconcile',
          queueId: 1,
          actorStaffId: 42,
          actorEmail: 'ops@example.com',
          reason: 'planned cutover',
        }),
      );
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
      const ops = new EmailQueueService(prisma as unknown as PrismaService, undefined, {
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
    it('accepts RESUME_MIGRATED with no extra fields', () => {
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'RESUME_MIGRATED' }).success).toBe(true);
    });

    it('rejects FROM_NOW without confirm + reason (the discard safety gate)', () => {
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'FROM_NOW' }).success).toBe(false);
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'FROM_NOW', confirm: true }).success).toBe(false);
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'FROM_NOW', reason: 'x' }).success).toBe(false);
      expect(
        ReconcileEmailQueueSchema.safeParse({ mode: 'FROM_NOW', confirm: true, reason: 'clean cutover' })
          .success,
      ).toBe(true);
    });

    it('rejects BACKFILL without a positive backfillLimit (else it silently equals FROM_NOW)', () => {
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'BACKFILL' }).success).toBe(false);
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'BACKFILL', backfillLimit: 0 }).success).toBe(false);
      expect(ReconcileEmailQueueSchema.safeParse({ mode: 'BACKFILL', backfillLimit: 500 }).success).toBe(
        true,
      );
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
