import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmailQueueService } from './email-queue.service';
import { ReconcileEmailQueueSchema } from './dto';
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
      groupBy: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    setting: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
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

  describe('health', () => {
    it('reports backlog + byState and raises halt / quarantine / stalled alerts', async () => {
      (prisma.emailQueue.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        makeSafeQueue({ id: 1, syncState: 'NEEDS_RECONCILIATION' }),
        makeSafeQueue({ id: 2, syncState: 'OK' }),
      ]);
      (prisma.inboundDelivery.groupBy as ReturnType<typeof vi.fn>).mockResolvedValue([
        { state: 'ACCEPTED', _count: { _all: 3 } },
        { state: 'RETRY', _count: { _all: 2 } },
        { state: 'QUARANTINED', _count: { _all: 1 } },
        { state: 'PROCESSED', _count: { _all: 10 } },
      ]);
      (prisma.inboundDelivery.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.inboundDelivery.count as ReturnType<typeof vi.fn>).mockResolvedValue(4); // stalled PROCESSING

      const out = await service.health(new Date('2026-07-18T12:00:00.000Z'));

      expect(out.ledger.backlog).toBe(5); // accepted 3 + retry 2
      expect(out.ledger.byState).toMatchObject({ accepted: 3, retry: 2, quarantined: 1, processed: 10 });
      expect(out.ledger.stalledProcessing).toBe(4);
      const kinds = out.alerts.map((a) => a.kind);
      expect(kinds).toContain('queue_halted');
      expect(kinds).toContain('quarantine');
      expect(kinds).toContain('stalled_processing');
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
});
