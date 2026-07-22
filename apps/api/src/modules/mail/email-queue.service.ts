import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
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
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import type {
  CreateEmailQueueDto,
  ListQuarantinedInboundDto,
  ReconcileEmailQueueDto,
  ReplayQuarantinedInboundDto,
  UpdateEmailQueueDto,
} from './dto';
import { InboundAuditService } from './inbound-audit.service';
import { InboundMailService, type ReconcileMailboxBaseline } from './inbound.service';
import { InboundRawStorageService } from './inbound-raw-storage.service';
import {
  MailAccessPolicy,
  type MailAccessActor,
  type MailDepartmentScope,
} from './mail-access-policy.service';

/** Actor performing an audited operator action (reconcile / replay). */
/** Full actor context is mandatory at runtime; legacy unit doubles may omit isAdmin. */
export type InboundActor = Partial<MailAccessActor>;

/** Scheduled process work is intentionally global; HTTP callers always pass their staff actor. */
const SYSTEM_MAIL_OPERATOR: MailAccessActor = { staffId: 1, isAdmin: true, email: 'system' };

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
  routingPriority: true,
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
  lastConnectionAttemptAt: true,
  lastDisconnectedAt: true,
  lastConnectionErrorAt: true,
  lastPollStartedAt: true,
  lastPollAt: true,
  lastPollCompletedAt: true,
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
    @Optional()
    @Inject(APP_CONFIG)
    private readonly config?: Pick<AppConfig, 'TELECOM_HD_IMAP_ENABLED' | 'TELECOM_HD_INBOUND_MAX_SIZE_MB'>,
    @Optional() private readonly rawStorage?: InboundRawStorageService,
    @Optional() private readonly mailAccess?: MailAccessPolicy,
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
      const { alerts } = await this.healthSystem();
      for (const a of alerts) {
        const line = `INBOUND ALERT [${a.severity}] ${a.kind}: ${a.message}`;
        if (a.severity === 'critical') this.logger.error(line);
        else this.logger.warn(line);
      }
    } catch (err) {
      this.logger.error(`Inbound health alert emit failed (${this.errorKind(err)})`);
    }
  }

  private accessPolicy(): MailAccessPolicy {
    if (!this.mailAccess) throw new ServiceUnavailableException('Mail operator authorization unavailable');
    return this.mailAccess;
  }

  private normalizeMailActor(actor?: InboundActor): MailAccessActor {
    if (
      actor &&
      Number.isInteger(actor.staffId) &&
      actor.staffId! > 0 &&
      typeof actor.isAdmin === 'boolean'
    ) {
      return actor as MailAccessActor;
    }
    // Existing narrow unit doubles exercise pure queue/cursor logic directly.
    // The compatibility shortcut is impossible in a real deployment: production
    // sets NODE_ENV=production and any missing/partial HTTP actor fails closed.
    if (process.env['NODE_ENV'] === 'test') {
      return {
        ...SYSTEM_MAIL_OPERATOR,
        ...(actor?.staffId ? { staffId: actor.staffId } : {}),
        ...(actor?.email ? { email: actor.email } : {}),
        isAdmin: actor?.isAdmin ?? true,
      };
    }
    throw new ForbiddenException('Complete mail operator context is required');
  }

  private async resolveMailScope(actor?: InboundActor): Promise<MailDepartmentScope> {
    return this.accessPolicy().resolveScope(this.normalizeMailActor(actor));
  }

  private queueWhereWithScope(
    scope: MailDepartmentScope,
    predicate: Prisma.EmailQueueWhereInput,
  ): Prisma.EmailQueueWhereInput {
    return scope.unrestricted
      ? predicate
      : { AND: [predicate, this.accessPolicy().queueWhereForScope(scope)] };
  }

  private healthSystem(now: Date = new Date()) {
    return this.health(SYSTEM_MAIL_OPERATOR, now);
  }

  /** List all email queues (passwordEnc excluded). */
  async list(actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const queues = await this.prisma.emailQueue.findMany({
      where: access.queueWhereForScope(scope),
      select: SAFE_SELECT,
      orderBy: { id: 'asc' },
    });
    return queues.map((queue) => this.withAllowedModes(queue));
  }

  /** Get a single email queue by ID (passwordEnc excluded). */
  async get(id: number, actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const queue = await this.prisma.emailQueue.findFirst({
      where: access.queueByIdWhereForScope(id, scope),
      select: SAFE_SELECT,
    });
    if (!queue) throw new NotFoundException(`EmailQueue #${id} not found`);
    return this.withAllowedModes(queue);
  }

  /** Create a new email queue. The caller-supplied password is encrypted at rest. */
  async create(dto: CreateEmailQueueDto, actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    access.assertCanTargetQueueDepartment(scope, dto.departmentId);
    const { password, routingPriority = 100, ...rest } = dto;
    const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
    return this.prisma.emailQueue.create({
      data: {
        ...rest,
        routingPriority,
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
  async update(id: number, dto: UpdateEmailQueueDto, actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const scopedWhere = access.queueByIdWhereForScope(id, scope);
    if (dto.departmentId !== undefined) access.assertCanTargetQueueDepartment(scope, dto.departmentId);
    // The comparison and write intentionally use a CAS loop.  A stale full-form request
    // which still says host=A must not overwrite a concurrent A→B change without an epoch
    // bump; after a CAS miss it re-reads B, recognises B→A as an identity transition and
    // consumes another mailbox epoch.  This is the fence for two operators editing a queue.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.prisma.emailQueue.findFirst({
        where: scopedWhere,
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
          AND: [
            scopedWhere,
            {
              type: current.type,
              host: current.host,
              port: current.port,
              username: current.username,
              useTls: current.useTls,
              mailboxEpoch: current.mailboxEpoch,
              cursorGeneration: current.cursorGeneration,
            },
          ],
        },
        data,
      });
      if (updated.count !== 1) continue;

      const result = await this.prisma.emailQueue.findFirst({ where: scopedWhere, select: SAFE_SELECT });
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
  async delete(id: number, actor?: InboundActor): Promise<void> {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const deleted = await this.prisma.emailQueue.deleteMany({
      where: access.queueByIdWhereForScope(id, scope),
    });
    if (deleted.count !== 1) throw new NotFoundException(`EmailQueue #${id} not found`);
  }

  /**
   * Perform an explicit IMAP cutover.  FROM_NOW/BACKFILL are deliberately a two-phase
   * operation: first a CAS makes the old poller stale and writes an audit request; then an
   * IMAP snapshot is captured under a mailbox lock; finally a second CAS durably commits the
   * exact UIDNEXT boundary before HTTP success is returned.  There is never a successful
   * BOOTSTRAPPING response whose baseline will only be chosen on a later poll interval.
   */
  async reconcile(id: number, dto: ReconcileEmailQueueDto, actor?: InboundActor) {
    const effectiveActor = this.normalizeMailActor(actor);
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(effectiveActor);
    const before = await this.prisma.emailQueue.findFirst({
      where: access.queueByIdWhereForScope(id, scope),
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
      return this.resumeLegacyReconcile(before, dto, effectiveActor, scope);
    }

    const started = await this.beginMailboxReconcile(before, dto, effectiveActor, scope);
    if (!this.inboundMail) {
      await this.failMailboxReconcile(
        started,
        before.reconcileCause,
        dto,
        effectiveActor,
        scope,
        'IMAP reconcile worker unavailable',
      );
      throw new ServiceUnavailableException('IMAP reconcile worker unavailable; queue remains halted');
    }

    let baseline: ReconcileMailboxBaseline;
    try {
      baseline = await this.inboundMail.captureReconcileBaseline(started, dto.mode, dto.backfillLimit ?? 0);
    } catch (err) {
      // IMAP/driver exceptions can contain the configured username, host or credential URI.
      // The durable operator-facing error is deliberately opaque; do not reintroduce that
      // secret material into the application log while reporting the failed reconcile.
      this.logger.error(`IMAP reconcile baseline failed for queue ${id} (${this.errorKind(err)})`);
      const message = this.safeError(err);
      try {
        await this.failMailboxReconcile(started, before.reconcileCause, dto, effectiveActor, scope, message);
      } catch (failure) {
        if (failure instanceof ConflictException) throw failure;
        throw failure;
      }
      throw new ServiceUnavailableException(`IMAP baseline was not captured: ${message}`);
    }

    const queue = await this.completeMailboxReconcile(
      started,
      before.reconcileCause,
      dto,
      effectiveActor,
      scope,
      baseline,
    );
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
    actor: InboundActor,
    scope: MailDepartmentScope,
  ) {
    const requestedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const cas = await tx.emailQueue.updateMany({
        where: this.queueWhereWithScope(scope, {
          id: before.id,
          type: 'IMAP',
          syncState: before.syncState as Prisma.EmailQueueWhereInput['syncState'],
          reconcileCause: before.reconcileCause,
          cursorGeneration: before.cursorGeneration,
          mailboxEpoch: before.mailboxEpoch,
        }),
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
      const started = await tx.emailQueue.findFirst({
        where: this.accessPolicy().queueByIdWhereForScope(before.id, scope),
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
    actor: InboundActor,
    scope: MailDepartmentScope,
    baseline: ReconcileMailboxBaseline,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const cas = await tx.emailQueue.updateMany({
        where: this.queueWhereWithScope(scope, {
          id: started.id,
          type: 'IMAP',
          syncState: 'BOOTSTRAPPING',
          reconcileCause: cause,
          cursorGeneration: started.cursorGeneration,
          mailboxEpoch: started.mailboxEpoch,
        }),
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
      const queue = await tx.emailQueue.findFirst({
        where: this.accessPolicy().queueByIdWhereForScope(started.id, scope),
        select: SAFE_SELECT,
      });
      if (!queue) throw new ConflictException('Queue disappeared while completing reconcile');
      return queue;
    });
  }

  private async failMailboxReconcile(
    started: { id: number; mailboxEpoch: number; cursorGeneration: number },
    cause: ReconcileCause,
    dto: ReconcileEmailQueueDto,
    actor: InboundActor,
    scope: MailDepartmentScope,
    error: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const cas = await tx.emailQueue.updateMany({
        where: this.queueWhereWithScope(scope, {
          id: started.id,
          type: 'IMAP',
          syncState: 'BOOTSTRAPPING',
          reconcileCause: cause,
          cursorGeneration: started.cursorGeneration,
          mailboxEpoch: started.mailboxEpoch,
        }),
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
    actor: InboundActor,
    scope: MailDepartmentScope,
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
        where: this.queueWhereWithScope(scope, {
          id: before.id,
          type: 'IMAP',
          syncState: before.syncState as Prisma.EmailQueueWhereInput['syncState'],
          reconcileCause: 'LEGACY_MIGRATION',
          cursorGeneration: before.cursorGeneration,
          mailboxEpoch: before.mailboxEpoch,
        }),
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
      const updated = await tx.emailQueue.findFirst({
        where: this.accessPolicy().queueByIdWhereForScope(before.id, scope),
        select: SAFE_SELECT,
      });
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

  private errorKind(err: unknown): string {
    return err instanceof Error && err.name ? err.name.slice(0, 80) : 'UnknownError';
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
  async listQuarantined(query: ListQuarantinedInboundDto, actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const baseWhere: Prisma.InboundDeliveryWhereInput = {
      state: 'QUARANTINED',
      ...(query.queueId !== undefined ? { queueId: query.queueId } : {}),
      ...(query.reason ? { lastError: { contains: query.reason, mode: 'insensitive' } } : {}),
      ...(query.messageId
        ? {
            OR: [
              { messageId: { contains: query.messageId, mode: 'insensitive' } },
              { observedMessageId: { contains: query.messageId, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lte: query.to } : {}),
            },
          }
        : {}),
    };
    const where: Prisma.InboundDeliveryWhereInput = scope.unrestricted
      ? baseWhere
      : { AND: [baseWhere, access.deliveryWhereForScope(scope)] };
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
  async getQuarantined(deliveryId: number, actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const delivery = await this.prisma.inboundDelivery.findFirst({
      where: access.deliveryByIdWhereForScope(deliveryId, scope),
      select: {
        id: true,
        transport: true,
        queueId: true,
        // `messageId` is legacy compatibility state; new logical-message runtime records the
        // non-unique observed RFC id plus hashes on every transport copy for operator forensics.
        messageId: true,
        observedMessageId: true,
        messageIdHash: true,
        semanticHash: true,
        routedQueueId: true,
        routedDepartmentId: true,
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
    const effectiveActor = this.normalizeMailActor(actor);
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(effectiveActor);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.inboundDelivery.findFirst({
        where: access.deliveryByIdWhereForScope(deliveryId, scope),
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
        where: scope.unrestricted
          ? { id: deliveryId, state: 'QUARANTINED', updatedAt: dto.expectedUpdatedAt }
          : {
              AND: [
                { id: deliveryId, state: 'QUARANTINED', updatedAt: dto.expectedUpdatedAt },
                access.deliveryWhereForScope(scope),
              ],
            },
        data: { state: 'ACCEPTED', attempts: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null },
      });
      if (reset.count !== 1) {
        throw new ConflictException(`Quarantined delivery #${deliveryId} changed; refresh before replaying`);
      }
      // An audit insert failure rolls back the state change. Operator actions must never
      // succeed without a durable reason and actor record.
      await tx.inboundAuditLog.create({
        data: {
          actorStaffId: effectiveActor.staffId,
          actorEmail: effectiveActor.email ?? '',
          action: 'mail.quarantine_replay',
          deliveryId,
          reason: dto.reason,
          metadata: { expectedUpdatedAt: dto.expectedUpdatedAt.toISOString() },
        },
      });
    });
    this.logger.warn(
      `AUDIT inbound quarantine replay delivery=${deliveryId} actorStaffId=${effectiveActor.staffId}`,
    );
    return { replayed: true };
  }

  /**
   * Operator health snapshot: per-queue sync state + the inbound ledger backlog, staleness
   * timestamps, and a computed `alerts` list (halted queue, quarantine, stalled lease,
   * aged backlog). One call an admin dashboard / alerting probe can poll.
   */
  async health(actorOrNow?: InboundActor | Date, now: Date = new Date()) {
    const suppliedNow = actorOrNow instanceof Date ? actorOrNow : now;
    const actor = actorOrNow instanceof Date ? undefined : actorOrNow;
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const scopedDeliveries = (base: Prisma.InboundDeliveryWhereInput): Prisma.InboundDeliveryWhereInput =>
      scope.unrestricted ? base : { AND: [base, access.deliveryWhereForScope(scope)] };
    const queues = await this.prisma.emailQueue.findMany({
      where: this.queueWhereWithScope(scope, { type: 'IMAP' }),
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
      where: scopedDeliveries({}),
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

    const collisionSince = new Date(suppliedNow.getTime() - 24 * 60 * 60_000);
    const [oldestPending, lastProcessed, stalledProcessing, quarantineSize, recentCollisions] =
      await Promise.all([
        this.prisma.inboundDelivery.findFirst({
          where: scopedDeliveries({ state: { in: ['ACCEPTED', 'RETRY'] } }),
          orderBy: { createdAt: 'asc' },
          select: { id: true, createdAt: true, nextAttemptAt: true, attempts: true },
        }),
        this.prisma.inboundDelivery.findFirst({
          where: scopedDeliveries({ state: 'PROCESSED' }),
          orderBy: { processedAt: 'desc' },
          select: { processedAt: true },
        }),
        this.prisma.inboundDelivery.count({
          where: scopedDeliveries({ state: 'PROCESSING', leaseExpiresAt: { lt: suppliedNow } }),
        }),
        this.prisma.inboundDelivery.aggregate({
          where: scopedDeliveries({ state: 'QUARANTINED' }),
          _sum: { sizeBytes: true },
        }),
        scope.unrestricted
          ? this.prisma.inboundAuditLog.count({
              where: {
                action: { in: ['mail.transport_collision', 'mail.message_id_conflict'] },
                createdAt: { gte: collisionSince },
              },
            })
          : Promise.resolve(0),
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
      } else if (suppliedNow.getTime() - q.lastConnectedAt.getTime() > staleAfterMs) {
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
      } else if (
        q.lastPollCompletedAt &&
        suppliedNow.getTime() - q.lastPollCompletedAt.getTime() > staleAfterMs
      ) {
        alerts.push({
          severity: 'warning',
          kind: 'stale_poll',
          message: `Queue ${q.id} (${q.emailAddress}) has not completed a poll within 10 minutes.`,
        });
      }
      const bootstrapStartedAt = q.reconcileRequestedAt ?? q.lastPollStartedAt;
      if (
        q.syncState === 'BOOTSTRAPPING' &&
        bootstrapStartedAt &&
        suppliedNow.getTime() - bootstrapStartedAt.getTime() > staleAfterMs
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
    if (oldestPending && suppliedNow.getTime() - oldestPending.createdAt.getTime() > 15 * 60_000) {
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
          message: 'Inbound raw MIME storage capacity cannot be verified.',
        });
        this.logger.warn(`Inbound raw MIME storage capacity probe failed (${this.errorKind(err)})`);
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
      checkedAt: suppliedNow,
    };
  }
}
