import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptField } from '../../common/field-encrypt.util';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import type {
  CreateEmailQueueDto,
  ListQuarantinedInboundDto,
  ReconcileEmailQueueDto,
  ReplayQuarantinedInboundDto,
  UpdateEmailQueueDto,
} from './dto';
import { InboundAuditService } from './inbound-audit.service';
import { InboundRawStorageService } from './inbound-raw-storage.service';

/** Actor performing an audited operator action (reconcile / replay). */
export interface InboundActor {
  staffId?: number;
  email?: string;
}

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
  lastConnectedAt: true,
  lastConnectionAttemptAt: true,
  lastDisconnectedAt: true,
  lastConnectionErrorAt: true,
  lastPollStartedAt: true,
  lastPollAt: true,
  lastPollCompletedAt: true,
  lastAcceptedAt: true,
} as const;

@Injectable()
export class EmailQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailQueueService.name);
  private healthAlertHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly inboundAudit?: InboundAuditService,
    @Optional()
    @Inject(APP_CONFIG)
    private readonly config?: Pick<AppConfig, 'TELECOM_HD_IMAP_ENABLED' | 'TELECOM_HD_INBOUND_MAX_SIZE_MB'>,
    @Optional() private readonly rawStorage?: InboundRawStorageService,
  ) {}

  /** Emit inbound health alerts on a schedule so a halted queue / quarantine backlog /
   *  stalled processing surfaces in the logs (and any log-based monitor) without an operator
   *  polling the health endpoint. Unref'd so it never keeps the process alive. */
  onModuleInit(): void {
    this.healthAlertHandle = setInterval(() => {
      void this.emitHealthAlerts();
    }, 5 * 60_000);
    this.healthAlertHandle.unref?.();
  }

  onModuleDestroy(): void {
    if (this.healthAlertHandle) clearInterval(this.healthAlertHandle);
  }

  private async emitHealthAlerts(): Promise<void> {
    try {
      const { alerts } = await this.health();
      for (const a of alerts) {
        const line = `INBOUND ALERT [${a.severity}] ${a.kind}: ${a.message}`;
        if (a.severity === 'critical') this.logger.error(line);
        else this.logger.warn(line);
      }
    } catch (err) {
      this.logger.error(`Inbound health alert emit failed: ${String(err)}`);
    }
  }

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

  /** Update an existing email queue (partial). Password is encrypted at rest if provided.
   *
   *  Mailbox-identity guard: changing host / port / username / TLS on an IMAP queue that
   *  already has a cursor makes the old UID cursor meaningless — and DANGEROUS if the new
   *  server happens to advertise the same UIDVALIDITY (the poller would resume at the stale
   *  UID and silently skip the new mailbox's earlier messages). So an identity change resets
   *  the cursor and HALTS the queue (NEEDS_RECONCILIATION, generation bumped) — the operator
   *  must then reconcile explicitly (FROM_NOW / BACKFILL). A password-only change is exempt. */
  async update(id: number, dto: UpdateEmailQueueDto) {
    const current = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: {
        type: true,
        host: true,
        port: true,
        username: true,
        useTls: true,
        uidValidity: true,
      },
    });
    if (!current) throw new NotFoundException(`EmailQueue #${id} not found`);

    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    if (password !== undefined) {
      const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      data.passwordEnc = encryptField(password, encKey);
    }

    const identityChanged =
      current.type === 'IMAP' &&
      ((rest.host !== undefined && rest.host !== current.host) ||
        (rest.port !== undefined && rest.port !== current.port) ||
        (rest.username !== undefined && rest.username !== current.username) ||
        (rest.useTls !== undefined && rest.useTls !== current.useTls));
    if (identityChanged && current.uidValidity !== null) {
      data.uidValidity = null;
      data.lastSeenUid = BigInt(0);
      data.syncState = 'NEEDS_RECONCILIATION';
      data.lastError =
        'Mailbox identity changed (host/username/port/TLS) — cursor reset; run reconcile to resume polling safely';
      data.cursorGeneration = { increment: 1 };
      data.bootstrapPolicy = null;
      data.bootstrapBackfillLimit = null;
      this.logger.warn(
        `EmailQueue ${id}: mailbox identity changed — cursor reset + halted (NEEDS_RECONCILIATION), reconcile required`,
      );
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
  async reconcile(id: number, dto: ReconcileEmailQueueDto, actor?: InboundActor) {
    const actorStaffId = actor?.staffId;
    const before = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: { type: true, uidValidity: true, lastSeenUid: true, syncState: true, cursorGeneration: true },
    });
    if (!before) throw new NotFoundException(`EmailQueue #${id} not found`);
    // Reconcile is an IMAP-cursor operation; refuse it on a non-IMAP (PIPE/POP3) queue so a
    // mistaken call cannot stamp a UID cursor onto a queue that has no UID space.
    if (before.type !== 'IMAP') {
      throw new BadRequestException(`Reconcile applies only to IMAP queues (queue #${id} is ${before.type})`);
    }

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
      // no-op. Never rewind above the watermark, never below 0. `reduce` (not a spread) so a
      // large failures array can't blow the argument-count limit.
      const minPending = legacy.pendingUids.reduce((m, u) => Math.min(m, u), Number.POSITIVE_INFINITY);
      const resumeCursor =
        legacy.pendingUids.length > 0
          ? Math.max(Math.min(legacy.watermark, minPending - 1), 0)
          : Math.max(legacy.watermark, 0);
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
      // BOOTSTRAPPING (not OK) until the poller fixes the high-water baseline: the queue is
      // reconciled but has no cursor yet, so health must not report it healthy in the window.
      data = {
        uidValidity: null,
        lastSeenUid: BigInt(0),
        syncState: 'BOOTSTRAPPING',
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
        syncState: 'BOOTSTRAPPING',
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

    // Durable audit row (actor + reason + before/after cursor) — survives log rotation and is
    // queryable per queue. BigInt fields are stringified so the JSONB metadata is serialisable.
    await this.inboundAudit?.log({
      actorStaffId,
      actorEmail: actor?.email,
      action: 'mail.reconcile',
      queueId: id,
      reason: dto.reason ?? null,
      metadata: {
        mode: dto.mode,
        before: {
          uidValidity: before.uidValidity?.toString() ?? null,
          lastSeenUid: before.lastSeenUid.toString(),
          syncState: before.syncState,
          cursorGeneration: before.cursorGeneration,
        },
        after: {
          uidValidity: after.uidValidity?.toString() ?? null,
          lastSeenUid: after.lastSeenUid.toString(),
          syncState: after.syncState,
          cursorGeneration: after.cursorGeneration,
        },
        detail,
      },
    });

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
      Number.isSafeInteger(state.watermark) &&
      state.watermark >= 0
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

  /**
   * Paginated quarantine index. It intentionally contains only metadata — raw MIME stays
   * in the ledger/storage and is never exposed by an operator listing endpoint.
   */
  async listQuarantined(query: ListQuarantinedInboundDto) {
    const where: Prisma.InboundDeliveryWhereInput = {
      state: 'QUARANTINED',
      ...(query.queueId !== undefined ? { queueId: query.queueId } : {}),
      ...(query.reason ? { lastError: { contains: query.reason, mode: 'insensitive' } } : {}),
      ...(query.messageId ? { messageId: { contains: query.messageId, mode: 'insensitive' } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };
    const select = {
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
      truncated: true,
      createdAt: true,
      updatedAt: true,
    } as const;
    const [items, total] = await this.prisma.$transaction([
      this.prisma.inboundDelivery.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select,
      }),
      this.prisma.inboundDelivery.count({ where }),
    ]);
    return {
      items: items.map((rawItem) => {
        // Defence in depth: Prisma select already omits the opaque key, but never reflect it if
        // a mock/future projection accidentally includes it.
        const { rawStorageKey: _rawStorageKey, ...item } = rawItem as typeof rawItem & {
          rawStorageKey?: string | null;
        };
        return { ...item, replayAllowed: !item.truncated };
      }),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /** Detail is metadata + durable operator audit, never the raw RFC822 payload. */
  async getQuarantined(deliveryId: number) {
    const delivery = await this.prisma.inboundDelivery.findUnique({
      where: { id: deliveryId },
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
        truncated: true,
        createdAt: true,
        updatedAt: true,
        state: true,
      },
    });
    if (!delivery || delivery.state !== 'QUARANTINED') {
      throw new NotFoundException(`Quarantined delivery #${deliveryId} not found`);
    }
    const audit = await this.prisma.inboundAuditLog.findMany({
      where: { deliveryId },
      orderBy: { id: 'desc' },
      take: 100,
      select: {
        id: true,
        actorStaffId: true,
        actorEmail: true,
        action: true,
        reason: true,
        metadata: true,
        createdAt: true,
      },
    });
    const { rawStorageKey: _rawStorageKey, ...safeDelivery } = delivery as typeof delivery & {
      rawStorageKey?: string | null;
    };
    return {
      delivery: {
        ...safeDelivery,
        replayAllowed: !safeDelivery.truncated,
        replayBlockReason: safeDelivery.truncated
          ? 'The stored MIME is truncated; safely replaying it requires a future original-message re-fetch.'
          : null,
      },
      audit,
    };
  }

  /**
   * Replay a quarantined delivery: reset it to ACCEPTED (attempts 0, lease cleared) so
   * the drain reprocesses it. The raw MIME was retained, so nothing was lost.
   */
  async replayQuarantined(deliveryId: number, dto: ReplayQuarantinedInboundDto, actor: InboundActor) {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.inboundDelivery.findUnique({
        where: { id: deliveryId },
        select: { state: true, truncated: true, updatedAt: true },
      });
      if (!current || current.state !== 'QUARANTINED') {
        throw new NotFoundException(`Quarantined delivery #${deliveryId} not found`);
      }
      // A truncated raw MIME is not the original message. Replaying it would create a
      // partial/incorrect ticket, so require an explicit future re-fetch capability first.
      if (current.truncated) {
        throw new BadRequestException(
          `Quarantined delivery #${deliveryId} has truncated raw MIME and cannot be replayed safely`,
        );
      }
      if (current.updatedAt.getTime() !== dto.expectedUpdatedAt.getTime()) {
        throw new ConflictException(`Quarantined delivery #${deliveryId} changed; refresh before replaying`);
      }
      const reset = await tx.inboundDelivery.updateMany({
        where: { id: deliveryId, state: 'QUARANTINED', updatedAt: dto.expectedUpdatedAt },
        data: { state: 'ACCEPTED', attempts: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null },
      });
      if (reset.count !== 1) {
        throw new ConflictException(`Quarantined delivery #${deliveryId} changed; refresh before replaying`);
      }
      // An audit insert failure rolls back the state change. Operator actions must never
      // succeed without a durable reason and actor record.
      await tx.inboundAuditLog.create({
        data: {
          actorStaffId: actor.staffId ?? null,
          actorEmail: actor.email ?? '',
          action: 'mail.quarantine_replay',
          deliveryId,
          reason: dto.reason,
          metadata: { expectedUpdatedAt: dto.expectedUpdatedAt.toISOString() },
        },
      });
    });
    this.logger.warn(
      `AUDIT inbound quarantine replay delivery=${deliveryId} actorStaffId=${actor?.staffId ?? 'system'}`,
    );
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
        lastConnectionAttemptAt: true,
        lastConnectedAt: true,
        lastDisconnectedAt: true,
        lastConnectionErrorAt: true,
        lastPollStartedAt: true,
        lastPollAt: true,
        lastPollCompletedAt: true,
        lastAcceptedAt: true,
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

    const collisionSince = new Date(now.getTime() - 24 * 60 * 60_000);
    const [oldestPending, lastProcessed, stalledProcessing, quarantineSize, recentCollisions] =
      await Promise.all([
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
        this.prisma.inboundDelivery.aggregate({
          where: { state: 'QUARANTINED' },
          _sum: { sizeBytes: true },
        }),
        this.prisma.inboundAuditLog.count({
          where: {
            action: { in: ['mail.transport_collision', 'mail.message_id_conflict'] },
            createdAt: { gte: collisionSince },
          },
        }),
      ]);

    const enabledQueues = queues.filter((q) => q.isEnabled);
    const halted = enabledQueues.filter((q) => q.syncState === 'NEEDS_RECONCILIATION').map((q) => q.id);
    const alerts: Array<{ severity: 'warning' | 'critical'; kind: string; message: string }> = [];
    if (enabledQueues.length > 0 && this.config?.TELECOM_HD_IMAP_ENABLED === false) {
      alerts.push({
        severity: 'critical',
        kind: 'imap_disabled',
        message: `${enabledQueues.length} enabled IMAP queue(s) exist but TELECOM_HD_IMAP_ENABLED is disabled.`,
      });
    }
    const staleAfterMs = 10 * 60_000;
    for (const q of enabledQueues) {
      if (!q.lastConnectedAt) {
        alerts.push({
          severity: 'critical',
          kind: 'never_connected',
          message: `Queue ${q.id} (${q.emailAddress}) has never connected to IMAP.`,
        });
      } else if (now.getTime() - q.lastConnectedAt.getTime() > staleAfterMs) {
        alerts.push({
          severity: 'warning',
          kind: 'stale_connection',
          message: `Queue ${q.id} (${q.emailAddress}) has not connected within 10 minutes.`,
        });
      }
      if (q.lastConnectionErrorAt && (!q.lastConnectedAt || q.lastConnectionErrorAt > q.lastConnectedAt)) {
        alerts.push({
          severity: 'warning',
          kind: 'connection_error',
          message: `Queue ${q.id} (${q.emailAddress}) has a newer IMAP connection error.`,
        });
      }
      if (q.lastPollStartedAt && (!q.lastPollCompletedAt || q.lastPollStartedAt > q.lastPollCompletedAt)) {
        alerts.push({
          severity: 'warning',
          kind: 'poll_running',
          message: `Queue ${q.id} (${q.emailAddress}) has a poll cycle still in progress.`,
        });
      } else if (q.lastPollCompletedAt && now.getTime() - q.lastPollCompletedAt.getTime() > staleAfterMs) {
        alerts.push({
          severity: 'warning',
          kind: 'stale_poll',
          message: `Queue ${q.id} (${q.emailAddress}) has not completed a poll within 10 minutes.`,
        });
      }
      if (
        q.syncState === 'BOOTSTRAPPING' &&
        q.lastPollStartedAt &&
        now.getTime() - q.lastPollStartedAt.getTime() > staleAfterMs
      ) {
        alerts.push({
          severity: 'warning',
          kind: 'bootstrap_stalled',
          message: `Queue ${q.id} (${q.emailAddress}) has been bootstrapping for over 10 minutes.`,
        });
      }
    }
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
    if (recentCollisions > 0) {
      alerts.push({
        severity: 'critical',
        kind: 'inbound_collision',
        message:
          `${recentCollisions} transport or Message-ID semantic collision audit event(s) occurred in the last 24 hours; ` +
          'review quarantine and the inbound audit trail before resuming normal operations.',
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

    // Large raw MIME lives under the existing uploads volume.  Its write path refuses an
    // incoming message that would cross the configured reserve; surface the same boundary to
    // operators before the next large delivery is rejected.  Capacity telemetry itself is
    // deliberately best-effort here: an unavailable probe is an alert, not a health-endpoint
    // outage that hides the rest of the ledger state.
    let storage: { availableBytes: string; reserveBytes: string; nearReserve: boolean } | null = null;
    if (this.rawStorage) {
      try {
        const capacity = await this.rawStorage.capacity();
        const nextInboundBytes = BigInt(this.config?.TELECOM_HD_INBOUND_MAX_SIZE_MB ?? 0) * 1024n * 1024n;
        const nearReserve = capacity.availableBytes < capacity.reserveBytes + nextInboundBytes;
        storage = {
          availableBytes: capacity.availableBytes.toString(),
          reserveBytes: capacity.reserveBytes.toString(),
          nearReserve,
        };
        if (nearReserve) {
          alerts.push({
            severity: 'warning',
            kind: 'raw_storage_near_reserve',
            message:
              'Inbound raw MIME storage is within one maximum inbound message of its configured reserve; ' +
              'new oversized deliveries will fail closed until capacity is restored.',
          });
        }
      } catch (err) {
        alerts.push({
          severity: 'warning',
          kind: 'raw_storage_capacity_unknown',
          message: `Inbound raw MIME storage capacity cannot be verified: ${String(err)}`,
        });
      }
    }

    return {
      queues,
      ledger: {
        backlog: byState.accepted + byState.retry,
        byState,
        quarantineBytes: quarantineSize._sum.sizeBytes ?? 0,
        stalledProcessing,
        oldestPendingAt: oldestPending?.createdAt ?? null,
        lastProcessedAt: lastProcessed?.processedAt ?? null,
      },
      rawStorage: storage,
      alerts,
      checkedAt: now,
    };
  }
}
