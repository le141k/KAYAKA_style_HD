import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmailQueueService } from './email-queue.service';
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
  return {
    emailQueue: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    inboundDelivery: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  } as unknown as PrismaService;
}

/** The projection the reconcile `before` snapshot reads. */
function makeCursorBefore(overrides: Record<string, unknown> = {}) {
  return { uidValidity: null, lastSeenUid: 0n, syncState: 'OK', cursorGeneration: 0, ...overrides };
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
      await service.reconcile(1, { mode: 'FROM_NOW', confirm: true, reason: 'clean cutover' }, 42);
      expect(prisma.emailQueue.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            syncState: 'OK',
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
      await service.reconcile(1, { mode: 'BACKFILL', backfillLimit: 250 }, 42);
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
      await service.reconcile(1, { mode: 'RESUME_MIGRATED' }, 42);
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
      await service.reconcile(1, { mode: 'RESUME_MIGRATED' }, 42);
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
      await expect(service.reconcile(1, { mode: 'RESUME_MIGRATED' }, 42)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.emailQueue.update).not.toHaveBeenCalled();
    });

    it('RESUME_MIGRATED: refuses when no legacy cursor exists at all', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeCursorBefore());
      (prisma.setting.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.reconcile(1, { mode: 'RESUME_MIGRATED' }, 42)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.emailQueue.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown queue', async () => {
      (prisma.emailQueue.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(
        service.reconcile(404, { mode: 'FROM_NOW', confirm: true, reason: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('replayQuarantined', () => {
    it('resets a QUARANTINED delivery back to ACCEPTED', async () => {
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      await expect(service.replayQuarantined(9)).resolves.toEqual({ replayed: true });
      expect(prisma.inboundDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 9, state: 'QUARANTINED' },
          data: expect.objectContaining({ state: 'ACCEPTED', attempts: 0 }),
        }),
      );
    });

    it('throws NotFoundException when the delivery is not quarantined', async () => {
      (prisma.inboundDelivery.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      await expect(service.replayQuarantined(9)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
