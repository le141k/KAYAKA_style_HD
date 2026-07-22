import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptField } from '../../common/field-encrypt.util';
import type { CreateEmailQueueDto, ReconcileEmailQueueDto, UpdateEmailQueueDto } from './dto';
import { InboundAuditService } from './inbound-audit.service';
import { InboundMailService, type ReconcileMailboxBaseline } from './inbound.service';

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
  mailboxEpoch: true,
  reconcileCause: true,
  reconcileRequestedAt: true,
  bootstrapPolicy: true,
  bootstrapBackfillLimit: true,
  lastConnectedAt: true,
  lastPollAt: true,
  lastAcceptedAt: true,
} as const;

type ReconcileMode = ReconcileEmailQueueDto['mode'];
type ReconcileCause =
  | 'LEGACY_MIGRATION'
  | 'UIDVALIDITY_CHANGED'
  | 'MAILBOX_IDENTITY_CHANGED'
  | 'MANUAL_FORCE'
  | 'TRANSPORT_COLLISION'
  | 'UNKNOWN'
  | null;

/** Server-side source of truth for the UI. Never infer this from lastError text. */
export function allowedReconcileModes(cause: ReconcileCause): ReconcileMode[] {
  switch (cause) {
    case 'LEGACY_MIGRATION':
      return ['RESUME_MIGRATED', 'FROM_NOW', 'BACKFILL'];
    case 'UIDVALIDITY_CHANGED':
    case 'MAILBOX_IDENTITY_CHANGED':
    case 'TRANSPORT_COLLISION':
    case 'UNKNOWN':
      return ['FROM_NOW', 'BACKFILL'];
    // A manual force is deliberately not accepted by the standard endpoint. It needs a
    // separately permissioned action rather than being smuggled through normal reconcile.
    case 'MANUAL_FORCE':
    case null:
      return [];
  }
}

@Injectable()
export class EmailQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailQueueService.name);
  private healthAlertHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly inboundAudit?: InboundAuditService,
    @Optional() private readonly inboundMail?: InboundMailService,
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
  async list() {
    const queues = await this.prisma.emailQueue.findMany({
      select: SAFE_SELECT,
      orderBy: { id: 'asc' },
    });
    return queues.map((queue) => this.withAllowedModes(queue));
  }

  /** Get a single email queue by ID (passwordEnc excluded). */
  async get(id: number) {
    const queue = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: SAFE_SELECT,
    });
    if (!queue) throw new NotFoundException(`EmailQueue #${id} not found`);
    return this.withAllowedModes(queue);
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
    // The comparison and write intentionally use a CAS loop.  A stale full-form request
    // which still says host=A must not overwrite a concurrent A→B change without an epoch
    // bump; after a CAS miss it re-reads B, recognises B→A as an identity transition and
    // consumes another mailbox epoch.  This is the fence for two operators editing a queue.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.prisma.emailQueue.findUnique({
        where: { id },
        select: {
          type: true,
          host: true,
          port: true,
          username: true,
          useTls: true,
          mailboxEpoch: true,
          cursorGeneration: true,
        },
      });
      if (!current) throw new NotFoundException(`EmailQueue #${id} not found`);

      const { password, ...rest } = dto;
      const data: Record<string, unknown> = { ...rest };
      if (password !== undefined) {
        const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
        data.passwordEnc = encryptField(password, encKey);
      }

      const nextType = rest.type ?? current.type;
      const touchesImap = current.type === 'IMAP' || nextType === 'IMAP';
      const identityChanged =
        touchesImap &&
        (nextType !== current.type ||
          (rest.host !== undefined && rest.host !== current.host) ||
          (rest.port !== undefined && rest.port !== current.port) ||
          (rest.username !== undefined && rest.username !== current.username) ||
          (rest.useTls !== undefined && rest.useTls !== current.useTls));

      if (identityChanged) {
        data.uidValidity = null;
        data.lastSeenUid = BigInt(0);
        data.syncState = 'NEEDS_RECONCILIATION';
        data.reconcileCause = 'MAILBOX_IDENTITY_CHANGED';
        data.reconcileRequestedAt = null;
        data.lastError =
          'Mailbox identity changed (host/username/port/TLS/type) — cursor reset; run FROM_NOW or bounded BACKFILL';
        data.cursorGeneration = { increment: 1 };
        data.mailboxEpoch = { increment: 1 };
        data.bootstrapPolicy = null;
        data.bootstrapBackfillLimit = null;
      }

      const updated = await this.prisma.emailQueue.updateMany({
        where: {
          id,
          type: current.type,
          host: current.host,
          port: current.port,
          username: current.username,
          useTls: current.useTls,
          mailboxEpoch: current.mailboxEpoch,
          cursorGeneration: current.cursorGeneration,
        },
        data,
      });
      if (updated.count !== 1) continue;

      const result = await this.prisma.emailQueue.findUnique({ where: { id }, select: SAFE_SELECT });
      if (!result) throw new NotFoundException(`EmailQueue #${id} not found`);
      if (identityChanged) {
        this.logger.warn(
          `EmailQueue ${id}: mailbox identity changed — epoch ${current.mailboxEpoch} → ${current.mailboxEpoch + 1}; reconciliation required`,
        );
      }
      return this.withAllowedModes(result);
    }
    throw new ConflictException(`EmailQueue #${id} changed concurrently; reload and retry`);
  }

  /** Delete an email queue. */
  async delete(id: number): Promise<void> {
    await this.get(id); // throws NotFoundException when missing
    await this.prisma.emailQueue.delete({ where: { id } });
  }

  /**
   * Perform an explicit IMAP cutover.  FROM_NOW/BACKFILL are deliberately a two-phase
   * operation: first a CAS makes the old poller stale and writes an audit request; then an
   * IMAP snapshot is captured under a mailbox lock; finally a second CAS durably commits the
   * exact UIDNEXT boundary before HTTP success is returned.  There is never a successful
   * BOOTSTRAPPING response whose baseline will only be chosen on a later poll interval.
   */
  async reconcile(id: number, dto: ReconcileEmailQueueDto, actor?: InboundActor) {
    const before = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        isEnabled: true,
        uidValidity: true,
        lastSeenUid: true,
        syncState: true,
        reconcileCause: true,
        cursorGeneration: true,
        mailboxEpoch: true,
      },
    });
    if (!before) throw new NotFoundException(`EmailQueue #${id} not found`);
    this.assertReconcileAllowed(before, dto);

    if (dto.mode === 'RESUME_MIGRATED') {
      return this.resumeLegacyReconcile(before, dto, actor);
    }

    const started = await this.beginMailboxReconcile(before, dto, actor);
    if (!this.inboundMail) {
      await this.failMailboxReconcile(
        started,
        before.reconcileCause,
        dto,
        actor,
        'IMAP reconcile worker unavailable',
      );
      throw new ServiceUnavailableException('IMAP reconcile worker unavailable; queue remains halted');
    }

    let baseline: ReconcileMailboxBaseline;
    try {
      baseline = await this.inboundMail.captureReconcileBaseline(started, dto.mode, dto.backfillLimit ?? 0);
    } catch (err) {
      this.logger.error(`IMAP reconcile baseline failed for queue ${id}: ${String(err)}`);
      const message = this.safeError(err);
      try {
        await this.failMailboxReconcile(started, before.reconcileCause, dto, actor, message);
      } catch (failure) {
        if (failure instanceof ConflictException) throw failure;
        throw failure;
      }
      throw new ServiceUnavailableException(`IMAP baseline was not captured: ${message}`);
    }

    const queue = await this.completeMailboxReconcile(started, before.reconcileCause, dto, actor, baseline);
    this.logger.warn(
      `AUDIT email-queue reconcile complete queue=${id} mode=${dto.mode} ` +
        `epoch=${started.mailboxEpoch} generation=${started.cursorGeneration} ` +
        `boundary=${baseline.boundary} cursor=${baseline.cursor}`,
    );
    return {
      reconciled: true,
      mode: dto.mode,
      queue: this.withAllowedModes(queue),
      detail: {
        boundary: baseline.boundary,
        cursor: baseline.cursor,
        uidValidity: baseline.uidValidity.toString(),
        backfillSelectedUids: baseline.selectedUids,
      },
    };
  }

  private assertReconcileAllowed(
    before: {
      type: string;
      syncState: string;
      reconcileCause: ReconcileCause;
      cursorGeneration: number;
    },
    dto: ReconcileEmailQueueDto,
  ): void {
    if (before.type !== 'IMAP') {
      throw new BadRequestException(`Reconcile applies only to IMAP queues (queue is ${before.type})`);
    }
    if (before.syncState === 'OK') {
      throw new BadRequestException('A healthy queue cannot be reconciled through the standard endpoint');
    }
    if (dto.expectedCursorGeneration !== before.cursorGeneration) {
      throw new ConflictException(
        `Queue cursor generation changed (expected ${dto.expectedCursorGeneration}, current ${before.cursorGeneration}); reload and retry`,
      );
    }
    if (!allowedReconcileModes(before.reconcileCause).includes(dto.mode)) {
      throw new BadRequestException(
        `Reconcile mode ${dto.mode} is not allowed for cause ${before.reconcileCause ?? 'none'}`,
      );
    }
  }

  private async beginMailboxReconcile(
    before: {
      id: number;
      type: string;
      uidValidity: bigint | null;
      lastSeenUid: bigint;
      syncState: string;
      reconcileCause: ReconcileCause;
      cursorGeneration: number;
      mailboxEpoch: number;
    },
    dto: ReconcileEmailQueueDto,
    actor?: InboundActor,
  ) {
    const requestedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const cas = await tx.emailQueue.updateMany({
        where: {
          id: before.id,
          type: 'IMAP',
          syncState: before.syncState as Prisma.EmailQueueWhereInput['syncState'],
          reconcileCause: before.reconcileCause,
          cursorGeneration: before.cursorGeneration,
          mailboxEpoch: before.mailboxEpoch,
        },
        data: {
          syncState: 'BOOTSTRAPPING',
          // The cursor/generation is invalidated before opening IMAP. A stale poller may
          // finish its fetch, but its acceptance fence/cursor CAS now has no matching row.
          cursorGeneration: { increment: 1 },
          uidValidity: null,
          lastSeenUid: BigInt(0),
          bootstrapPolicy: null,
          bootstrapBackfillLimit: null,
          reconcileRequestedAt: requestedAt,
          lastError: null,
        },
      });
      if (cas.count !== 1) {
        throw new ConflictException('Queue changed while reconcile was requested; reload and retry');
      }
      await this.appendReconcileAudit(tx, {
        action: 'mail.reconcile_requested',
        queueId: before.id,
        actor,
        reason: dto.reason,
        metadata: this.reconcileAuditMetadata(before, dto, { requestedAt: requestedAt.toISOString() }),
      });
      const started = await tx.emailQueue.findUnique({
        where: { id: before.id },
        select: {
          id: true,
          host: true,
          port: true,
          username: true,
          passwordEnc: true,
          useTls: true,
          mailboxEpoch: true,
          cursorGeneration: true,
        },
      });
      if (!started) throw new ConflictException('Queue disappeared while reconcile was requested');
      return started;
    });
  }

  private async completeMailboxReconcile(
    started: {
      id: number;
      mailboxEpoch: number;
      cursorGeneration: number;
    },
    cause: ReconcileCause,
    dto: ReconcileEmailQueueDto,
    actor: InboundActor | undefined,
    baseline: ReconcileMailboxBaseline,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const cas = await tx.emailQueue.updateMany({
        where: {
          id: started.id,
          type: 'IMAP',
          syncState: 'BOOTSTRAPPING',
          reconcileCause: cause,
          cursorGeneration: started.cursorGeneration,
          mailboxEpoch: started.mailboxEpoch,
        },
        data: {
          uidValidity: baseline.uidValidity,
          lastSeenUid: BigInt(baseline.cursor),
          syncState: 'OK',
          reconcileCause: null,
          reconcileRequestedAt: null,
          lastError: null,
          bootstrapPolicy: null,
          bootstrapBackfillLimit: null,
        },
      });
      if (cas.count !== 1) {
        throw new ConflictException('Queue changed while IMAP baseline was captured; baseline was discarded');
      }
      await this.appendReconcileAudit(tx, {
        action: 'mail.reconcile_completed',
        queueId: started.id,
        actor,
        reason: dto.reason,
        metadata: {
          mode: dto.mode,
          mailboxEpoch: started.mailboxEpoch,
          cursorGeneration: started.cursorGeneration,
          uidValidity: baseline.uidValidity.toString(),
          boundary: baseline.boundary,
          cursor: baseline.cursor,
          selectedUids: baseline.selectedUids,
        },
      });
      const queue = await tx.emailQueue.findUnique({ where: { id: started.id }, select: SAFE_SELECT });
      if (!queue) throw new ConflictException('Queue disappeared while completing reconcile');
      return queue;
    });
  }

  private async failMailboxReconcile(
    started: { id: number; mailboxEpoch: number; cursorGeneration: number },
    cause: ReconcileCause,
    dto: ReconcileEmailQueueDto,
    actor: InboundActor | undefined,
    error: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const cas = await tx.emailQueue.updateMany({
        where: {
          id: started.id,
          type: 'IMAP',
          syncState: 'BOOTSTRAPPING',
          reconcileCause: cause,
          cursorGeneration: started.cursorGeneration,
          mailboxEpoch: started.mailboxEpoch,
        },
        data: {
          syncState: 'NEEDS_RECONCILIATION',
          lastError: `Reconcile baseline failed: ${error}`.slice(0, 1_000),
          bootstrapPolicy: null,
          bootstrapBackfillLimit: null,
        },
      });
      if (cas.count !== 1) {
        throw new ConflictException(
          'Queue changed while IMAP baseline failed; no stale failure state was written',
        );
      }
      await this.appendReconcileAudit(tx, {
        action: 'mail.reconcile_failed',
        queueId: started.id,
        actor,
        reason: dto.reason,
        metadata: {
          mode: dto.mode,
          mailboxEpoch: started.mailboxEpoch,
          cursorGeneration: started.cursorGeneration,
          error,
        },
      });
    });
  }

  private async resumeLegacyReconcile(
    before: {
      id: number;
      type: string;
      uidValidity: bigint | null;
      lastSeenUid: bigint;
      syncState: string;
      reconcileCause: ReconcileCause;
      cursorGeneration: number;
      mailboxEpoch: number;
    },
    dto: ReconcileEmailQueueDto,
    actor?: InboundActor,
  ) {
    const legacy = await this.readLegacyCursor(before.id);
    if (!legacy) {
      throw new BadRequestException(
        `No legacy IMAP cursor found for queue #${before.id} (Setting imap/state:${before.id} or imap/lastSeenUid:${before.id}).`,
      );
    }
    if (legacy.uidValidity === null) {
      throw new BadRequestException(
        `Legacy cursor for queue #${before.id} has no UIDVALIDITY and cannot be resumed safely`,
      );
    }
    const legacyUidValidity = legacy.uidValidity;
    const minPending = legacy.pendingUids.reduce((m, u) => Math.min(m, u), Number.POSITIVE_INFINITY);
    const resumeCursor =
      legacy.pendingUids.length > 0
        ? Math.max(Math.min(legacy.watermark, minPending - 1), 0)
        : Math.max(legacy.watermark, 0);
    const requestedAt = new Date();
    const queue = await this.prisma.$transaction(async (tx) => {
      const cas = await tx.emailQueue.updateMany({
        where: {
          id: before.id,
          type: 'IMAP',
          syncState: before.syncState as Prisma.EmailQueueWhereInput['syncState'],
          reconcileCause: 'LEGACY_MIGRATION',
          cursorGeneration: before.cursorGeneration,
          mailboxEpoch: before.mailboxEpoch,
        },
        data: {
          uidValidity: legacyUidValidity,
          lastSeenUid: BigInt(resumeCursor),
          syncState: 'OK',
          reconcileCause: null,
          reconcileRequestedAt: null,
          lastError: null,
          cursorGeneration: { increment: 1 },
          bootstrapPolicy: null,
          bootstrapBackfillLimit: null,
        },
      });
      if (cas.count !== 1) throw new ConflictException('Queue changed while legacy reconcile was requested');
      const detail = {
        uidValidity: legacyUidValidity.toString(),
        watermark: legacy.watermark,
        resumeCursor,
        pendingUids: legacy.pendingUids,
      };
      await this.appendReconcileAudit(tx, {
        action: 'mail.reconcile_requested',
        queueId: before.id,
        actor,
        reason: dto.reason,
        metadata: this.reconcileAuditMetadata(before, dto, { requestedAt: requestedAt.toISOString() }),
      });
      await this.appendReconcileAudit(tx, {
        action: 'mail.reconcile_completed',
        queueId: before.id,
        actor,
        reason: dto.reason,
        metadata: { mode: dto.mode, mailboxEpoch: before.mailboxEpoch, ...detail },
      });
      const updated = await tx.emailQueue.findUnique({ where: { id: before.id }, select: SAFE_SELECT });
      if (!updated) throw new ConflictException('Queue disappeared while completing legacy reconcile');
      return { updated, detail };
    });
    return {
      reconciled: true,
      mode: dto.mode,
      queue: this.withAllowedModes(queue.updated),
      detail: queue.detail,
    };
  }

  private async appendReconcileAudit(
    tx: Prisma.TransactionClient,
    entry: {
      action: 'mail.reconcile_requested' | 'mail.reconcile_completed' | 'mail.reconcile_failed';
      queueId: number;
      actor?: InboundActor;
      reason?: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.inboundAuditLog.create({
      data: {
        actorStaffId: entry.actor?.staffId ?? null,
        actorEmail: entry.actor?.email ?? '',
        action: entry.action,
        queueId: entry.queueId,
        reason: entry.reason ?? null,
        metadata: entry.metadata as Prisma.InputJsonValue,
      },
    });
  }

  private reconcileAuditMetadata(
    before: {
      uidValidity: bigint | null;
      lastSeenUid: bigint;
      syncState: string;
      reconcileCause: ReconcileCause;
      cursorGeneration: number;
      mailboxEpoch: number;
    },
    dto: ReconcileEmailQueueDto,
    extra: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      mode: dto.mode,
      expectedCursorGeneration: dto.expectedCursorGeneration,
      before: {
        uidValidity: before.uidValidity?.toString() ?? null,
        lastSeenUid: before.lastSeenUid.toString(),
        syncState: before.syncState,
        reconcileCause: before.reconcileCause,
        cursorGeneration: before.cursorGeneration,
        mailboxEpoch: before.mailboxEpoch,
      },
      ...extra,
    };
  }

  private withAllowedModes<T extends { reconcileCause: ReconcileCause; syncState: string }>(queue: T) {
    return {
      ...queue,
      allowedModes: queue.syncState === 'OK' ? [] : allowedReconcileModes(queue.reconcileCause),
    };
  }

  private safeError(err: unknown): string {
    // Queue lastError and audit metadata are exposed to admins.  Keep the detailed driver
    // exception in server logs only: both driver errors and wrapped HTTP exceptions can
    // include host/user/auth diagnostics.  Do not make a future caller's exception message
    // an accidental persistent-data API.
    void err;
    return 'IMAP baseline capture failed';
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
  async replayQuarantined(deliveryId: number, actor?: InboundActor) {
    const reset = await this.prisma.inboundDelivery.updateMany({
      where: { id: deliveryId, state: 'QUARANTINED' },
      data: { state: 'ACCEPTED', attempts: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null },
    });
    if (reset.count === 0) {
      throw new NotFoundException(`Quarantined delivery #${deliveryId} not found`);
    }
    await this.inboundAudit?.log({
      actorStaffId: actor?.staffId ?? null,
      actorEmail: actor?.email,
      action: 'mail.quarantine_replay',
      deliveryId,
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
        mailboxEpoch: true,
        reconcileCause: true,
        reconcileRequestedAt: true,
        bootstrapPolicy: true,
        lastConnectedAt: true,
        lastPollAt: true,
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
    const collisions = queues.filter((q) => q.reconcileCause === 'TRANSPORT_COLLISION').map((q) => q.id);
    if (collisions.length) {
      alerts.push({
        severity: 'critical',
        kind: 'transport_collision',
        message: `Queue(s) ${collisions.join(', ')} saw an IMAP UID/content collision — inspect audit before reconciling.`,
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
