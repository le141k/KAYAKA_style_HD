import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptField } from '../../common/field-encrypt.util';
import type { CreateEmailQueueDto, ReconcileEmailQueueDto, UpdateEmailQueueDto } from './dto';

/** Fields that are always omitted from responses (stored password). */
const SAFE_SELECT = {
  id: true,
  type: true,
  emailAddress: true,
  host: true,
  port: true,
  username: true,
  useTls: true,
  departmentId: true,
  signature: true,
  isEnabled: true,
  createdAt: true,
  // Inbound sync health (operator visibility).
  syncState: true,
  lastError: true,
  lastSeenUid: true,
  uidValidity: true,
  cursorGeneration: true,
  bootstrapPolicy: true,
  bootstrapBackfillLimit: true,
} as const;

@Injectable()
export class EmailQueueService {
  private readonly logger = new Logger(EmailQueueService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** List all email queues (passwordEnc excluded). */
  list() {
    return this.prisma.emailQueue.findMany({
      select: SAFE_SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** Get a single email queue by ID (passwordEnc excluded). */
  async get(id: number) {
    const queue = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: SAFE_SELECT,
    });
    if (!queue) throw new NotFoundException(`EmailQueue #${id} not found`);
    return queue;
  }

  /** Create a new email queue. The caller-supplied password is encrypted at rest. */
  create(dto: CreateEmailQueueDto) {
    const { password, ...rest } = dto;
    const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
    return this.prisma.emailQueue.create({
      data: {
        ...rest,
        passwordEnc: encryptField(password ?? '', encKey),
      },
      select: SAFE_SELECT,
    });
  }

  /** Update an existing email queue (partial). Password is encrypted at rest if provided. */
  async update(id: number, dto: UpdateEmailQueueDto) {
    await this.get(id); // throws NotFoundException when missing
    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    if (password !== undefined) {
      const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      data.passwordEnc = encryptField(password, encKey);
    }
    return this.prisma.emailQueue.update({
      where: { id },
      data,
      select: SAFE_SELECT,
    });
  }

  /** Delete an email queue. */
  async delete(id: number): Promise<void> {
    await this.get(id); // throws NotFoundException when missing
    await this.prisma.emailQueue.delete({ where: { id } });
  }

  /**
   * Cutover / reconcile a halted (NEEDS_RECONCILIATION) or paused IMAP queue onto the
   * ledger cursor. Every branch bumps `cursorGeneration` (invalidating any in-flight stale
   * poller's CAS) and audits the before/after cursor + UIDVALIDITY + mode + actor.
   *
   *  - `RESUME_MIGRATED` carries the legacy Setting cursor forward: `imap/state:<id>`
   *    (primary — UIDVALIDITY + watermark, rewound past still-pending UIDs) or the bare
   *    `imap/lastSeenUid:<id>` (fallback — refused when it has no UIDVALIDITY).
   *  - `FROM_NOW` DISCARDS the legacy cursor and re-bootstraps at the current high-water
   *    UID (requires confirm + reason — it can skip mail that arrived unprocessed).
   *  - `BACKFILL` re-bootstraps and additionally rewinds by `backfillLimit`.
   */
  async reconcile(id: number, dto: ReconcileEmailQueueDto, actorStaffId?: number) {
    const before = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: { uidValidity: true, lastSeenUid: true, syncState: true, cursorGeneration: true },
    });
    if (!before) throw new NotFoundException(`EmailQueue #${id} not found`);

    let data: Prisma.EmailQueueUpdateInput;
    let detail: Record<string, unknown> = {};

    if (dto.mode === 'RESUME_MIGRATED') {
      const legacy = await this.readLegacyCursor(id);
      if (!legacy) {
        throw new BadRequestException(
          `No legacy IMAP cursor found for queue #${id} (Setting imap/state:${id} or imap/lastSeenUid:${id}). ` +
            `Use FROM_NOW or a bounded BACKFILL instead.`,
        );
      }
      if (legacy.uidValidity === null) {
        throw new BadRequestException(
          `Legacy cursor for queue #${id} has no UIDVALIDITY (pre-upgrade watermark) and cannot be resumed ` +
            `safely across UID-space generations. Verify the mailbox, then use FROM_NOW or a bounded BACKFILL.`,
        );
      }
      // Rewind past still-pending UIDs so a message the legacy poller had not finished is
      // re-fetched; the ledger's Message-ID idempotency makes any already-created ticket a
      // no-op. Never rewind above the watermark, never below 0.
      const resumeCursor =
        legacy.pendingUids.length > 0
          ? Math.max(Math.min(legacy.watermark, Math.min(...legacy.pendingUids) - 1), 0)
          : legacy.watermark;
      data = {
        uidValidity: legacy.uidValidity,
        lastSeenUid: BigInt(resumeCursor),
        syncState: 'OK',
        lastError: null,
        cursorGeneration: { increment: 1 },
        bootstrapPolicy: null,
        bootstrapBackfillLimit: null,
      };
      detail = {
        uidValidity: legacy.uidValidity.toString(),
        watermark: legacy.watermark,
        resumeCursor,
        pendingUids: legacy.pendingUids,
      };
    } else if (dto.mode === 'FROM_NOW') {
      data = {
        uidValidity: null,
        lastSeenUid: BigInt(0),
        syncState: 'OK',
        lastError: null,
        cursorGeneration: { increment: 1 },
        bootstrapPolicy: 'FROM_NOW',
        bootstrapBackfillLimit: null,
      };
    } else {
      // BACKFILL
      data = {
        uidValidity: null,
        lastSeenUid: BigInt(0),
        syncState: 'OK',
        lastError: null,
        cursorGeneration: { increment: 1 },
        bootstrapPolicy: 'BACKFILL',
        bootstrapBackfillLimit: dto.backfillLimit ?? null,
      };
      detail = { backfillLimit: dto.backfillLimit ?? null };
    }

    const after = await this.prisma.emailQueue.update({ where: { id }, data, select: SAFE_SELECT });

    // Audit: old/new cursor + UIDVALIDITY + mode + actor + reason (structured, log-aggregatable).
    this.logger.warn(
      `AUDIT email-queue reconcile queue=${id} mode=${dto.mode} ` +
        `actorStaffId=${actorStaffId ?? 'system'} reason=${JSON.stringify(dto.reason ?? null)} ` +
        `before={uidValidity:${before.uidValidity?.toString() ?? 'null'},lastSeenUid:${before.lastSeenUid.toString()},` +
        `syncState:${before.syncState},gen:${before.cursorGeneration}} ` +
        `after={uidValidity:${after.uidValidity?.toString() ?? 'null'},lastSeenUid:${after.lastSeenUid.toString()},` +
        `syncState:${after.syncState},gen:${after.cursorGeneration}} detail=${JSON.stringify(detail)}`,
    );

    return { reconciled: true, mode: dto.mode, queue: after, detail };
  }

  /**
   * Read the legacy Setting IMAP cursor for a queue: `imap/state:<id>` (primary — the
   * hardened `{ uidValidity, watermark, failures }` shape) or the pre-upgrade bare numeric
   * `imap/lastSeenUid:<id>` (fallback, no UIDVALIDITY). Returns null when neither exists.
   */
  private async readLegacyCursor(
    queueId: number,
  ): Promise<{ uidValidity: bigint | null; watermark: number; pendingUids: number[] } | null> {
    const stateRow = await this.prisma.setting.findUnique({
      where: { section_key: { section: 'imap', key: `state:${queueId}` } },
      select: { value: true },
    });
    const state = stateRow?.value as
      | { uidValidity?: unknown; watermark?: unknown; failures?: unknown }
      | null
      | undefined;
    if (
      state &&
      typeof state === 'object' &&
      typeof state.watermark === 'number' &&
      Number.isSafeInteger(state.watermark)
    ) {
      const uidValidity =
        typeof state.uidValidity === 'string' && /^\d+$/.test(state.uidValidity)
          ? BigInt(state.uidValidity)
          : null;
      const pendingUids = Array.isArray(state.failures)
        ? state.failures
            .filter(
              (f): f is { uid: number; status: string } =>
                !!f &&
                typeof f === 'object' &&
                (f as { status?: unknown }).status === 'pending' &&
                typeof (f as { uid?: unknown }).uid === 'number',
            )
            .map((f) => f.uid)
        : [];
      return { uidValidity, watermark: state.watermark, pendingUids };
    }

    const legacyRow = await this.prisma.setting.findUnique({
      where: { section_key: { section: 'imap', key: `lastSeenUid:${queueId}` } },
      select: { value: true },
    });
    const legacyValue = legacyRow?.value;
    if (typeof legacyValue === 'number' && Number.isSafeInteger(legacyValue) && legacyValue >= 0) {
      return { uidValidity: null, watermark: legacyValue, pendingUids: [] };
    }
    return null;
  }

  /** List quarantined inbound deliveries (metadata only — never the raw MIME blob). */
  listQuarantined() {
    return this.prisma.inboundDelivery.findMany({
      where: { state: 'QUARANTINED' },
      orderBy: { id: 'desc' },
      take: 200,
      select: {
        id: true,
        transport: true,
        queueId: true,
        messageId: true,
        envelopeFrom: true,
        envelopeTo: true,
        subject: true,
        sizeBytes: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Replay a quarantined delivery: reset it to ACCEPTED (attempts 0, lease cleared) so
   * the drain reprocesses it. The raw MIME was retained, so nothing was lost.
   */
  async replayQuarantined(deliveryId: number) {
    const reset = await this.prisma.inboundDelivery.updateMany({
      where: { id: deliveryId, state: 'QUARANTINED' },
      data: { state: 'ACCEPTED', attempts: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null },
    });
    if (reset.count === 0) {
      throw new NotFoundException(`Quarantined delivery #${deliveryId} not found`);
    }
    return { replayed: true };
  }

  /**
   * Operator health snapshot: per-queue sync state + the inbound ledger backlog, staleness
   * timestamps, and a computed `alerts` list (halted queue, quarantine, stalled lease,
   * aged backlog). One call an admin dashboard / alerting probe can poll.
   */
  async health(now: Date = new Date()) {
    const queues = await this.prisma.emailQueue.findMany({
      where: { type: 'IMAP' },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        emailAddress: true,
        isEnabled: true,
        syncState: true,
        lastError: true,
        lastSeenUid: true,
        uidValidity: true,
        cursorGeneration: true,
        bootstrapPolicy: true,
      },
    });

    const grouped = await this.prisma.inboundDelivery.groupBy({
      by: ['state'],
      _count: { _all: true },
    });
    const count = (state: string): number => grouped.find((g) => g.state === state)?._count._all ?? 0;
    const byState = {
      accepted: count('ACCEPTED'),
      processing: count('PROCESSING'),
      retry: count('RETRY'),
      quarantined: count('QUARANTINED'),
      processed: count('PROCESSED'),
      skipped: count('SKIPPED'),
    };

    const [oldestPending, lastProcessed, stalledProcessing] = await Promise.all([
      this.prisma.inboundDelivery.findFirst({
        where: { state: { in: ['ACCEPTED', 'RETRY'] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true, nextAttemptAt: true, attempts: true },
      }),
      this.prisma.inboundDelivery.findFirst({
        where: { state: 'PROCESSED' },
        orderBy: { processedAt: 'desc' },
        select: { processedAt: true },
      }),
      this.prisma.inboundDelivery.count({
        where: { state: 'PROCESSING', leaseExpiresAt: { lt: now } },
      }),
    ]);

    const halted = queues.filter((q) => q.syncState === 'NEEDS_RECONCILIATION').map((q) => q.id);
    const alerts: Array<{ severity: 'warning' | 'critical'; kind: string; message: string }> = [];
    if (halted.length) {
      alerts.push({
        severity: 'critical',
        kind: 'queue_halted',
        message: `Queue(s) ${halted.join(', ')} are NEEDS_RECONCILIATION — polling is halted until reconciled.`,
      });
    }
    if (byState.quarantined > 0) {
      alerts.push({
        severity: 'warning',
        kind: 'quarantine',
        message: `${byState.quarantined} inbound delivery(ies) quarantined — review and replay.`,
      });
    }
    if (stalledProcessing > 0) {
      alerts.push({
        severity: 'warning',
        kind: 'stalled_processing',
        message: `${stalledProcessing} delivery(ies) are PROCESSING past their lease — awaiting drain reclaim.`,
      });
    }
    // Aged backlog: a still-pending delivery older than 15 min signals a stuck drain.
    if (oldestPending && now.getTime() - oldestPending.createdAt.getTime() > 15 * 60_000) {
      alerts.push({
        severity: 'warning',
        kind: 'aged_backlog',
        message: `Oldest pending delivery #${oldestPending.id} has waited over 15 minutes.`,
      });
    }

    return {
      queues,
      ledger: {
        backlog: byState.accepted + byState.retry,
        byState,
        stalledProcessing,
        oldestPendingAt: oldestPending?.createdAt ?? null,
        lastProcessedAt: lastProcessed?.processedAt ?? null,
      },
      alerts,
      checkedAt: now,
    };
  }
}
