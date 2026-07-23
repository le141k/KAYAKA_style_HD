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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptField } from '../../common/field-encrypt.util';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import {
  DEFAULT_IMAP_MAILBOX,
  isKnownUnsafeCaptureMailbox,
  normalizeImapMailbox as normalizeRequestedImapMailbox,
  readCanonicalImapMailbox,
} from './dto';
import type {
  CreateEmailQueueDto,
  DeleteEmailQueueDto,
  ListCapturedInboundDto,
  ListQuarantinedInboundDto,
  PromoteCapturedInboundDto,
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

const CAPTURED_DELIVERY_STATE = 'CAPTURED' as const;
const FIELD_ENCRYPTION_KEY_PATTERN = /^[0-9a-f]{64}$/i;

/** Defence in depth for internal callers that bypass the HTTP Zod schema. */
function normalizeImapMailbox(value: string | undefined | null): string {
  try {
    return normalizeRequestedImapMailbox(value ?? DEFAULT_IMAP_MAILBOX);
  } catch {
    throw new BadRequestException('mailbox must be a non-empty IMAP folder name up to 255 characters');
  }
}

/** A non-canonical durable row is not normalized at runtime: halt instead of selecting another folder. */
function readPersistedImapMailbox(value: unknown): string {
  try {
    return readCanonicalImapMailbox(value);
  } catch {
    throw new ServiceUnavailableException('Configured IMAP mailbox is invalid or non-canonical');
  }
}

type CapturePromotionConfig = Pick<
  AppConfig,
  | 'TELECOM_HD_IMAP_ENABLED'
  | 'TELECOM_HD_INBOUND_DELIVERY_ENABLED'
  | 'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED'
  | 'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID'
  | 'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES'
  | 'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID'
  | 'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID'
  | 'TELECOM_HD_INBOUND_MAX_SIZE_MB'
  | 'TELECOM_HD_FIELD_ENCRYPTION_KEY'
>;

/** Fields that are always omitted from responses (stored password). */
const SAFE_SELECT = {
  id: true,
  type: true,
  emailAddress: true,
  host: true,
  port: true,
  username: true,
  useTls: true,
  mailbox: true,
  departmentId: true,
  signature: true,
  routingPriority: true,
  sendAutoresponder: true,
  configGeneration: true,
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
  captureRetiredAt: true,
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
    private readonly config?: CapturePromotionConfig,
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

  /**
   * Queue passwords are credentials, not ordinary development fields.  Refuse a
   * non-empty write unless this process has a valid AES-256 key, rather than relying
   * on encryptField's legacy plaintext compatibility path.  This is especially
   * important for the attended Gmail test, where the operator enters a fresh app
   * password through this API/UI.
   */
  private encryptQueuePassword(password: string | undefined): string {
    const value = password ?? '';
    if (value === '') return '';
    const key = this.config?.TELECOM_HD_FIELD_ENCRYPTION_KEY;
    if (!key || !FIELD_ENCRYPTION_KEY_PATTERN.test(key)) {
      throw new ServiceUnavailableException(
        'Email queue credentials cannot be stored until a valid field-encryption key is configured',
      );
    }
    return encryptField(value, key);
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

  /**
   * A captured row must remain inert until the runtime has left capture-only mode AND the normal
   * delivery/drain gate is explicitly open. This is fail-closed for a missing config field during
   * a staged rollout: an operator cannot accidentally turn a test capture into a ticket.
   */
  private assertCapturePromotionEnabled(): { queueId: number; deliveryId: number } {
    const config = this.config;
    if (
      config?.TELECOM_HD_INBOUND_DELIVERY_ENABLED !== true ||
      config?.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED !== false
    ) {
      throw new ConflictException(
        'Captured deliveries can be promoted only when inbound capture-only mode is disabled and normal delivery is enabled',
      );
    }
    const canary = this.normalCanaryPromotionScope();
    if (!canary) {
      throw new ConflictException(
        'Captured delivery promotion requires one exact normal-canary queue and delivery selector',
      );
    }
    return canary;
  }

  /**
   * A normal inbound canary may promote exactly the delivery named in its
   * environment selector. This backend check is authoritative; the UI may hide
   * other buttons, but it must never be able to manufacture future ACCEPTED
   * backlog outside the attended one-row experiment.
   */
  private normalCanaryPromotionScope(): { queueId: number; deliveryId: number } | null {
    const queueId = this.config?.TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID;
    const deliveryId = this.config?.TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID;
    const validQueueId = Number.isSafeInteger(queueId) && queueId! > 0;
    const validDeliveryId = Number.isSafeInteger(deliveryId) && deliveryId! > 0;
    if (!validQueueId && !validDeliveryId) return null;
    if (!validQueueId || !validDeliveryId) {
      throw new ConflictException(
        'Inbound normal canary selector is incomplete; captured promotion is fail-closed',
      );
    }
    return { queueId: queueId!, deliveryId: deliveryId! };
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
    const { password, routingPriority = 100, mailbox, ...rest } = dto;
    return this.prisma.emailQueue.create({
      data: {
        ...rest,
        mailbox: normalizeImapMailbox(mailbox),
        routingPriority,
        passwordEnc: this.encryptQueuePassword(password),
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
    const current = await this.prisma.emailQueue.findFirst({
      where: scopedWhere,
      select: {
        type: true,
        host: true,
        port: true,
        username: true,
        useTls: true,
        mailbox: true,
        mailboxEpoch: true,
        cursorGeneration: true,
        configGeneration: true,
        syncState: true,
        captureRetiredAt: true,
      },
    });
    if (!current) throw new NotFoundException(`EmailQueue #${id} not found`);
    const retiredQueueDisableOnly =
      current.captureRetiredAt !== null &&
      dto.isEnabled === false &&
      Object.keys(dto).every((key) => key === 'expectedConfigGeneration' || key === 'isEnabled');
    if (current.captureRetiredAt !== null && !retiredQueueDisableOnly) {
      throw new ConflictException(
        'This capture-only queue is permanently retired from normal ingress; create a new queue and mailbox instead',
      );
    }
    if (current.syncState === 'BOOTSTRAPPING') {
      throw new ConflictException('Queue is reconciling; reload after the IMAP baseline completes');
    }
    if (dto.expectedConfigGeneration !== current.configGeneration) {
      throw new ConflictException(
        `Queue configuration changed (expected ${dto.expectedConfigGeneration}, current ${current.configGeneration}); reload and retry`,
      );
    }

    // A queue form carries every editable field. It must be a single optimistic
    // write: re-reading and retrying after a CAS miss would let a stale form put
    // back a previous mailbox identity/address/department.
    const {
      password,
      expectedConfigGeneration: _expectedConfigGeneration,
      mailbox: requestedMailbox,
      ...rest
    } = dto;
    void _expectedConfigGeneration;
    const data: Record<string, unknown> = { ...rest, configGeneration: { increment: 1 } };
    if (requestedMailbox !== undefined) data.mailbox = normalizeImapMailbox(requestedMailbox);
    if (password !== undefined) {
      data.passwordEnc = this.encryptQueuePassword(password);
    }

    const nextType = rest.type ?? current.type;
    const currentMailbox = readPersistedImapMailbox(current.mailbox);
    const nextMailbox = (data.mailbox as string | undefined) ?? currentMailbox;
    const touchesImap = current.type === 'IMAP' || nextType === 'IMAP';
    const configuredCaptureQueueId = this.config?.TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID;
    if (
      this.config?.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED === true &&
      id === configuredCaptureQueueId &&
      nextType === 'IMAP' &&
      isKnownUnsafeCaptureMailbox(nextMailbox)
    ) {
      throw new BadRequestException(
        'Capture-only requires an empty dedicated IMAP test folder; Inbox and provider special-use folders are refused',
      );
    }
    const identityChanged =
      touchesImap &&
      (nextType !== current.type ||
        (rest.host !== undefined && rest.host !== current.host) ||
        (rest.port !== undefined && rest.port !== current.port) ||
        (rest.username !== undefined && rest.username !== current.username) ||
        (rest.useTls !== undefined && rest.useTls !== current.useTls) ||
        nextMailbox !== currentMailbox);

    if (identityChanged) {
      data.uidValidity = null;
      data.lastSeenUid = BigInt(0);
      data.syncState = 'NEEDS_RECONCILIATION';
      data.reconcileCause = 'MAILBOX_IDENTITY_CHANGED';
      data.reconcileRequestedAt = null;
      data.lastError =
        'Mailbox identity changed (host/username/port/TLS/folder/type) — cursor reset; run FROM_NOW or bounded BACKFILL';
      data.cursorGeneration = { increment: 1 };
      data.mailboxEpoch = { increment: 1 };
      data.bootstrapPolicy = null;
      data.bootstrapBackfillLimit = null;
    }

    const updated = await this.prisma.emailQueue.updateMany({
      // `beginMailboxReconcile()` moves a queue to BOOTSTRAPPING and advances its cursor
      // generation without changing configGeneration. Fence all reconcile-owned snapshot
      // fields here so a form read just before that transition cannot invalidate the
      // completion CAS and strand the queue in BOOTSTRAPPING.
      where: {
        AND: [
          scopedWhere,
          { configGeneration: current.configGeneration },
          { syncState: current.syncState },
          { cursorGeneration: current.cursorGeneration },
          { mailboxEpoch: current.mailboxEpoch },
          { captureRetiredAt: current.captureRetiredAt },
        ],
      },
      data,
    });
    if (updated.count !== 1) {
      throw new ConflictException('Queue changed concurrently; reload and retry');
    }

    const result = await this.prisma.emailQueue.findFirst({ where: scopedWhere, select: SAFE_SELECT });
    if (!result) throw new NotFoundException(`EmailQueue #${id} not found`);
    if (identityChanged) {
      this.logger.warn(
        `EmailQueue ${id}: mailbox identity changed — epoch ${current.mailboxEpoch} → ${current.mailboxEpoch + 1}; reconciliation required`,
      );
    }
    return this.withAllowedModes(result);
  }

  /**
   * Delete an email queue only from the version the operator inspected. BOOTSTRAPPING holds an
   * IMAP mailbox lock and a two-phase baseline, so deleting it mid-cutover is always rejected
   * server-side (the admin UI is only a convenience, never the safety boundary).
   */
  async delete(id: number, dto: DeleteEmailQueueDto, actor?: InboundActor): Promise<void> {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const scopedWhere = access.queueByIdWhereForScope(id, scope);
    const current = await this.prisma.emailQueue.findFirst({
      where: scopedWhere,
      select: { configGeneration: true, syncState: true, captureRetiredAt: true },
    });
    if (!current) throw new NotFoundException(`EmailQueue #${id} not found`);
    if (current.captureRetiredAt !== null) {
      throw new ConflictException(
        'This capture-only queue is permanently retired and cannot be deleted; create a new queue and mailbox instead',
      );
    }
    if (current.syncState === 'BOOTSTRAPPING') {
      throw new ConflictException(
        'Queue is reconciling; it cannot be deleted until the IMAP baseline completes',
      );
    }
    if (dto.expectedConfigGeneration !== current.configGeneration) {
      throw new ConflictException(
        `Queue configuration changed (expected ${dto.expectedConfigGeneration}, current ${current.configGeneration}); reload and retry`,
      );
    }
    const deleted = await this.prisma.emailQueue.deleteMany({
      where: {
        AND: [
          scopedWhere,
          { configGeneration: current.configGeneration },
          { syncState: { not: 'BOOTSTRAPPING' } },
          { captureRetiredAt: null },
        ],
      },
    });
    if (deleted.count !== 1) throw new ConflictException('Queue changed concurrently; reload and retry');
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
        configGeneration: true,
        mailbox: true,
        useTls: true,
        captureRetiredAt: true,
      },
    });
    if (!before) throw new NotFoundException(`EmailQueue #${id} not found`);
    if (before.captureRetiredAt !== null) {
      throw new ConflictException(
        'This capture-only queue is permanently retired and cannot be reconciled; create a new queue and mailbox instead',
      );
    }
    if (this.config?.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED === true) {
      throw new ConflictException(
        'Capture-only queues are armed and baselined only by the capture supervisor; reconcile is disabled for this attended test',
      );
    }
    this.assertCaptureReconcileScope(before, dto);
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

  /**
   * While capture-only is active, reconciliation is not a harmless admin read:
   * FROM_NOW/BACKFILL opens a mailbox and can commit a cursor boundary. Restrict it
   * to the one selected test queue before BOOTSTRAPPING or any IMAP connection is
   * attempted. This closes the otherwise separate reconcile path around the polling
   * and PIPE capture fences.
   */
  private assertCaptureReconcileScope(
    before: { id: number; type: string; mailbox?: string; useTls?: boolean },
    dto: Pick<ReconcileEmailQueueDto, 'mode'>,
  ): void {
    if (this.config?.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED !== true) return;
    const selectedId = this.config.TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID;
    if (
      typeof selectedId !== 'number' ||
      !Number.isSafeInteger(selectedId) ||
      selectedId < 1 ||
      before.id !== selectedId
    ) {
      throw new ConflictException(
        'Capture-only mode permits reconcile only for its explicitly selected test queue',
      );
    }
    if (dto.mode !== 'FROM_NOW') {
      throw new ConflictException(
        'Capture-only permits only FROM_NOW; historical mailbox import is refused for the attended test',
      );
    }
    if (before.type === 'IMAP' && before.useTls !== true) {
      throw new ConflictException('Capture-only requires implicit TLS for the selected IMAP test queue');
    }
    if (before.type === 'IMAP' && isKnownUnsafeCaptureMailbox(readPersistedImapMailbox(before.mailbox))) {
      throw new ConflictException(
        'Capture-only requires an empty dedicated IMAP test folder; Inbox and provider special-use folders are refused',
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
      configGeneration: number;
      mailbox?: string;
      useTls?: boolean;
      captureRetiredAt: Date | null;
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
          configGeneration: before.configGeneration,
          mailbox: readPersistedImapMailbox(before.mailbox),
          captureRetiredAt: before.captureRetiredAt,
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
          mailbox: true,
          mailboxEpoch: true,
          cursorGeneration: true,
          configGeneration: true,
          captureRetiredAt: true,
        },
      });
      if (!started) throw new ConflictException('Queue disappeared while reconcile was requested');
      return { ...started, mailbox: readPersistedImapMailbox(started.mailbox) };
    });
  }

  private async completeMailboxReconcile(
    started: {
      id: number;
      mailboxEpoch: number;
      cursorGeneration: number;
      configGeneration: number;
      mailbox: string;
      captureRetiredAt: Date | null;
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
          configGeneration: started.configGeneration,
          mailbox: started.mailbox,
          captureRetiredAt: started.captureRetiredAt,
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
    started: {
      id: number;
      mailboxEpoch: number;
      cursorGeneration: number;
      configGeneration: number;
      mailbox: string;
      captureRetiredAt: Date | null;
    },
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
          configGeneration: started.configGeneration,
          mailbox: started.mailbox,
          captureRetiredAt: started.captureRetiredAt,
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
      configGeneration: number;
      mailbox?: string;
      captureRetiredAt: Date | null;
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
          configGeneration: before.configGeneration,
          mailbox: readPersistedImapMailbox(before.mailbox),
          captureRetiredAt: before.captureRetiredAt,
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
      mailbox?: string;
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
        mailbox: readPersistedImapMailbox(before.mailbox),
      },
      ...extra,
    };
  }

  private withAllowedModes<
    T extends { reconcileCause: ReconcileCause; syncState: string; captureRetiredAt?: Date | null },
  >(queue: T) {
    return {
      ...queue,
      allowedModes:
        queue.captureRetiredAt != null || queue.syncState === 'OK'
          ? []
          : allowedReconcileModes(queue.reconcileCause),
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
      // Generic audit JSON is deliberately not an HTTP contract. Transport adapters may
      // add implementation detail to it later (for example an opaque raw-storage key),
      // while operators only need this actor/action/reason timeline to decide on replay.
      audit: audit.map((entry) => {
        const {
          metadata: _metadata,
          rawMime: _rawMime,
          rawStorageKey: _rawStorageKey,
          ...safeEntry
        } = entry as typeof entry & {
          metadata?: unknown;
          rawMime?: Buffer | null;
          rawStorageKey?: string | null;
        };
        return safeEntry;
      }),
    };
  }

  /**
   * Serialize delivery transitions with capture arming.  `armCaptureQueue()` takes
   * this queue row lock before it checks for normal work; every normal transition
   * must take the same lock before it can make a row processable.
   */
  private async lockDeliveryQueueCaptureState(
    tx: Prisma.TransactionClient,
    queueId: number | null,
    expectCaptureRetired: boolean,
  ): Promise<boolean> {
    // Old, intentionally orphaned normal ledger rows retain their raw MIME but
    // cannot originate from a capture-retired queue: deletion of such a queue is
    // blocked by both this service and the database trigger.
    if (queueId === null) return !expectCaptureRetired;
    const queues = await tx.$queryRaw<Array<{ id: number; captureRetiredAt: Date | null }>>(Prisma.sql`
      SELECT "id", "captureRetiredAt"
      FROM "EmailQueue"
      WHERE "id" = ${queueId}
      FOR UPDATE
    `);
    const queue = queues[0];
    if (!queue) return false;
    return expectCaptureRetired ? queue.captureRetiredAt !== null : queue.captureRetiredAt === null;
  }

  /**
   * Replay a quarantined delivery: reset it to ACCEPTED (attempts 0, lease cleared) so
   * the drain reprocesses it. The raw MIME was retained, so nothing was lost.
   */
  async replayQuarantined(deliveryId: number, dto: ReplayQuarantinedInboundDto, actor: InboundActor) {
    // Capture-only is an inert, IMAP-only evidence-gathering window. Replaying any
    // pre-existing quarantine would leave normal work ACCEPTED for the next restart,
    // so refuse it before even reading or mutating the ledger.
    if (this.config?.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED === true) {
      throw new ConflictException(
        'Quarantined deliveries cannot be replayed while inbound capture-only mode is active',
      );
    }
    const effectiveActor = this.normalizeMailActor(actor);
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(effectiveActor);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.inboundDelivery.findFirst({
        where: access.deliveryByIdWhereForScope(deliveryId, scope),
        select: { state: true, truncated: true, updatedAt: true, queueId: true },
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
      if (!(await this.lockDeliveryQueueCaptureState(tx, current.queueId, false))) {
        throw new ConflictException(
          `Quarantined delivery #${deliveryId} belongs to a capture-retired queue and cannot be replayed`,
        );
      }
      const reset = await tx.inboundDelivery.updateMany({
        where: {
          AND: [
            { id: deliveryId, state: 'QUARANTINED', updatedAt: dto.expectedUpdatedAt },
            // Keep the marker in the transition CAS as well as under the row lock:
            // a mocked/future caller cannot accidentally turn this into a read-only
            // advisory check.
            { NOT: { queue: { is: { captureRetiredAt: { not: null } } } } },
            ...(scope.unrestricted ? [] : [access.deliveryWhereForScope(scope)]),
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
   * Paginated capture-only index. Capture mode deliberately preserves the message bytes in the
   * ledger while preventing ticket work; operators may inspect safe delivery metadata before
   * explicitly promoting an individual row. Raw MIME and object-storage keys never leave this
   * service through this endpoint.
   */
  async listCaptured(query: ListCapturedInboundDto, actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const baseWhere: Prisma.InboundDeliveryWhereInput = {
      state: CAPTURED_DELIVERY_STATE,
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
      observedMessageId: true,
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
        // Defence in depth: keep a future mock/projection from reflecting an opaque key even
        // though the Prisma projection above excludes it.
        const {
          rawMime: _rawMime,
          rawStorageKey: _rawStorageKey,
          ...item
        } = rawItem as typeof rawItem & {
          rawMime?: Buffer | null;
          rawStorageKey?: string | null;
        };
        return {
          ...item,
          promoteAllowed: !item.truncated,
          promoteBlockReason: item.truncated
            ? 'The stored MIME is truncated; it cannot be promoted to ticket processing safely.'
            : null,
        };
      }),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  /**
   * Capture-only detail is intentionally limited to delivery and audit metadata. In
   * particular, this is not a raw-MIME download endpoint and it does not disclose opaque
   * external storage keys.
   */
  async getCaptured(deliveryId: number, actor?: InboundActor) {
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(actor);
    const delivery = await this.prisma.inboundDelivery.findFirst({
      where: access.deliveryByIdWhereForScope(deliveryId, scope),
      select: {
        id: true,
        transport: true,
        queueId: true,
        messageId: true,
        observedMessageId: true,
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
    if (!delivery || delivery.state !== CAPTURED_DELIVERY_STATE) {
      throw new NotFoundException(`Captured delivery #${deliveryId} not found`);
    }
    // Do not select generic JSON metadata here: audit metadata can contain implementation
    // details supplied by a transport adapter. The durable actor/action/reason timeline is the
    // operator information needed for promotion without risking a raw-storage-key disclosure.
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
        createdAt: true,
      },
    });
    const {
      rawMime: _rawMime,
      rawStorageKey: _rawStorageKey,
      ...safeDelivery
    } = delivery as typeof delivery & {
      rawMime?: Buffer | null;
      rawStorageKey?: string | null;
    };
    const safeAudit = audit.map((entry) => {
      // Prisma's select excludes metadata, but strip it again so a mock/future projection cannot
      // inadvertently expose a transport implementation detail such as rawStorageKey.
      const {
        metadata: _metadata,
        rawMime: _rawMime,
        rawStorageKey: _rawStorageKey,
        ...safeEntry
      } = entry as typeof entry & {
        metadata?: unknown;
        rawMime?: Buffer | null;
        rawStorageKey?: string | null;
      };
      return safeEntry;
    });
    return {
      delivery: {
        ...safeDelivery,
        promoteAllowed: !safeDelivery.truncated,
        promoteBlockReason: safeDelivery.truncated
          ? 'The stored MIME is truncated; it cannot be promoted to ticket processing safely.'
          : null,
      },
      audit: safeAudit,
    };
  }

  /**
   * Promote one deliberately captured delivery into normal durable processing. The compare and
   * state transition use the inspected row version, and the operator audit is in the same
   * transaction so CAPTURED -> ACCEPTED never succeeds without a durable reason.
   */
  async promoteCaptured(deliveryId: number, dto: PromoteCapturedInboundDto, actor: InboundActor) {
    const canary = this.assertCapturePromotionEnabled();
    if (canary.deliveryId !== deliveryId) {
      throw new ConflictException(
        'Only the selected captured delivery may be promoted during the inbound normal canary',
      );
    }
    const effectiveActor = this.normalizeMailActor(actor);
    const access = this.accessPolicy();
    const scope = await this.resolveMailScope(effectiveActor);
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.inboundDelivery.findFirst({
        where: access.deliveryByIdWhereForScope(deliveryId, scope),
        select: { state: true, truncated: true, updatedAt: true, queueId: true },
      });
      if (!current || current.state !== CAPTURED_DELIVERY_STATE) {
        throw new NotFoundException(`Captured delivery #${deliveryId} not found`);
      }
      if (current.queueId !== canary.queueId) {
        throw new ConflictException(
          'Selected captured delivery does not belong to the inbound normal canary queue',
        );
      }
      if (!(await this.lockDeliveryQueueCaptureState(tx, current.queueId, true))) {
        throw new ConflictException(
          'Captured delivery does not belong to a capture-retired queue and cannot be promoted',
        );
      }
      // A truncated record is not a faithful original message. Never let a capture-only review
      // turn incomplete bytes into a customer ticket.
      if (current.truncated) {
        throw new BadRequestException(
          `Captured delivery #${deliveryId} has truncated raw MIME and cannot be promoted safely`,
        );
      }
      if (current.updatedAt.getTime() !== dto.expectedUpdatedAt.getTime()) {
        throw new ConflictException(`Captured delivery #${deliveryId} changed; refresh before promoting`);
      }
      const promoted = await tx.inboundDelivery.updateMany({
        where: {
          AND: [
            {
              id: deliveryId,
              queueId: canary.queueId,
              state: CAPTURED_DELIVERY_STATE,
              updatedAt: dto.expectedUpdatedAt,
            },
            { queue: { is: { captureRetiredAt: { not: null } } } },
            ...(scope.unrestricted ? [] : [access.deliveryWhereForScope(scope)]),
          ],
        },
        data: {
          state: 'ACCEPTED',
          capturePromotedAt: new Date(),
          // A captured row is visible to its dedicated test queue for review. Once promoted
          // into normal processing, hide it from non-admin operators until parsing resolves
          // the real ticket owner (thread target / parser rule / deterministic route).
          effectiveOwnerKind: 'UNRESOLVED',
          effectiveOwnerDepartmentId: null,
          effectiveOwnerTicketId: null,
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (promoted.count !== 1) {
        throw new ConflictException(`Captured delivery #${deliveryId} changed; refresh before promoting`);
      }
      await tx.inboundAuditLog.create({
        data: {
          actorStaffId: effectiveActor.staffId,
          actorEmail: effectiveActor.email ?? '',
          action: 'mail.capture_promoted',
          deliveryId,
          reason: dto.reason,
          metadata: { expectedUpdatedAt: dto.expectedUpdatedAt.toISOString() },
        },
      });
    });
    this.logger.warn(
      `AUDIT inbound capture promoted delivery=${deliveryId} actorStaffId=${effectiveActor.staffId}`,
    );
    return { promoted: true };
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
        mailbox: true,
        useTls: true,
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
        captureRetiredAt: true,
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
      captured: count('CAPTURED'),
      processing: count('PROCESSING'),
      retry: count('RETRY'),
      quarantined: count('QUARANTINED'),
      processed: count('PROCESSED'),
      skipped: count('SKIPPED'),
    };

    const collisionSince = new Date(suppliedNow.getTime() - 24 * 60 * 60_000);
    const [
      oldestPending,
      oldestCaptured,
      lastProcessed,
      stalledProcessing,
      quarantineSize,
      capturedSize,
      recentCollisions,
    ] = await Promise.all([
      this.prisma.inboundDelivery.findFirst({
        where: scopedDeliveries({ state: { in: ['ACCEPTED', 'RETRY'] } }),
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true, nextAttemptAt: true, attempts: true },
      }),
      this.prisma.inboundDelivery.findFirst({
        where: scopedDeliveries({ state: CAPTURED_DELIVERY_STATE }),
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
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
      this.prisma.inboundDelivery.aggregate({
        where: scopedDeliveries({ state: CAPTURED_DELIVERY_STATE }),
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
    const retiredCaptureQueues = queues.filter((q) => q.captureRetiredAt !== null);
    const alerts: Array<{ severity: 'warning' | 'critical'; kind: string; message: string }> = [];
    const captureOnly = this.config?.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED === true;
    const normalInboundDeliveryEnabled = this.config?.TELECOM_HD_INBOUND_DELIVERY_ENABLED === true;
    const configuredCaptureQueueId = this.config?.TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID;
    const captureQueueId =
      captureOnly &&
      typeof configuredCaptureQueueId === 'number' &&
      Number.isSafeInteger(configuredCaptureQueueId) &&
      configuredCaptureQueueId > 0 &&
      (scope.unrestricted || queues.some((queue) => queue.id === configuredCaptureQueueId))
        ? configuredCaptureQueueId
        : null;
    const configuredCaptureMax = this.config?.TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES;
    const captureMaxMessages =
      captureOnly &&
      typeof configuredCaptureMax === 'number' &&
      Number.isSafeInteger(configuredCaptureMax) &&
      configuredCaptureMax >= 1 &&
      configuredCaptureMax <= 100
        ? configuredCaptureMax
        : null;
    const selectedCaptureQueue =
      captureQueueId === null ? undefined : queues.find((queue) => queue.id === captureQueueId);
    const captureEncryptionReady = /^[0-9a-f]{64}$/i.test(this.config?.TELECOM_HD_FIELD_ENCRYPTION_KEY ?? '');
    const captureRuntimeReady =
      captureQueueId !== null && this.inboundMail?.isCaptureQueueReady(captureQueueId) === true;
    // The UI must not infer test readiness from an env id alone. A capture canary is safe
    // to send only after the server confirms a visible, enabled dedicated IMAP folder has
    // completed its FROM_NOW baseline under the active capture gates.
    const captureTarget = !captureOnly
      ? null
      : !selectedCaptureQueue
        ? {
            queueId: null,
            ready: false,
            reason:
              'The selected capture queue is missing, outside your scope, or is not a visible IMAP queue. Do not send a test message.',
          }
        : !selectedCaptureQueue.isEnabled
          ? {
              queueId: selectedCaptureQueue.id,
              ready: false,
              reason: 'The selected capture queue is disabled.',
            }
          : selectedCaptureQueue.useTls !== true
            ? {
                queueId: selectedCaptureQueue.id,
                ready: false,
                reason:
                  'The selected capture queue must use implicit TLS before a credential-bearing test can start.',
              }
            : isKnownUnsafeCaptureMailbox(selectedCaptureQueue.mailbox)
              ? {
                  queueId: selectedCaptureQueue.id,
                  ready: false,
                  reason: 'The selected capture queue uses Inbox or a provider special-use folder.',
                }
              : this.config?.TELECOM_HD_IMAP_ENABLED !== true
                ? {
                    queueId: selectedCaptureQueue.id,
                    ready: false,
                    reason: 'IMAP polling is disabled globally.',
                  }
                : !captureEncryptionReady
                  ? {
                      queueId: selectedCaptureQueue.id,
                      ready: false,
                      reason: 'The local field-encryption key is not configured safely.',
                    }
                  : captureMaxMessages !== 1
                    ? {
                        queueId: selectedCaptureQueue.id,
                        ready: false,
                        reason: 'The attended test requires an exactly one-message capture limit.',
                      }
                    : selectedCaptureQueue.syncState !== 'OK' || selectedCaptureQueue.uidValidity === null
                      ? {
                          queueId: selectedCaptureQueue.id,
                          ready: false,
                          reason: 'The selected queue has not completed a healthy IMAP baseline yet.',
                        }
                      : selectedCaptureQueue.captureRetiredAt === null
                        ? {
                            queueId: selectedCaptureQueue.id,
                            ready: false,
                            reason:
                              'The selected queue has not been durably armed for capture-only; restart the API and wait for the safety fence before sending a test message.',
                          }
                        : !captureRuntimeReady
                          ? {
                              queueId: selectedCaptureQueue.id,
                              ready: false,
                              reason:
                                'The server has not yet verified the selected folder as a live empty capture target. Do not send a test message.',
                            }
                          : { queueId: selectedCaptureQueue.id, ready: true, reason: null };
    if (captureOnly) {
      alerts.push({
        severity: 'warning',
        kind: 'capture_only_active',
        message:
          'Inbound capture-only mode is active: selected test mail is stored without ticket processing or outbound mail.',
      });
      if (!captureTarget?.ready) {
        alerts.push({
          severity: 'critical',
          kind: 'capture_target_not_ready',
          message:
            captureTarget?.reason ?? 'The selected capture target is not ready. Do not send a test message.',
        });
      }
      if (selectedCaptureQueue && isKnownUnsafeCaptureMailbox(selectedCaptureQueue.mailbox)) {
        alerts.push({
          severity: 'critical',
          kind: 'capture_mailbox_unsafe',
          message:
            'Capture-only selected an IMAP queue using an unsafe special-use folder. The runtime refuses it; choose a new empty test folder before retrying.',
        });
      }
      if (captureMaxMessages === null) {
        alerts.push({
          severity: 'critical',
          kind: 'capture_configuration_invalid',
          message: 'Capture-only message limit is invalid; the runtime remains fail-closed.',
        });
      }
    } else if (this.config?.TELECOM_HD_INBOUND_DELIVERY_ENABLED === false) {
      alerts.push({
        severity: 'critical',
        kind: 'inbound_delivery_disabled',
        message:
          'Inbound delivery is disabled globally; IMAP and PIPE acceptance/drain are paused until an attended restart enables it.',
      });
    }
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
    if (!captureOnly) {
      for (const queue of retiredCaptureQueues) {
        alerts.push({
          severity: 'warning',
          kind: `capture_queue_retired_${queue.id}`,
          message:
            `Queue #${queue.id} is permanently retired after capture-only use and is excluded from normal inbound; ` +
            'create a new queue and mailbox for future mail tests.',
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
        capturedBytes: capturedSize._sum.sizeBytes ?? 0,
        stalledProcessing,
        oldestPendingAt: oldestPending?.createdAt ?? null,
        oldestCapturedAt: oldestCaptured?.createdAt ?? null,
        lastProcessedAt: lastProcessed?.processedAt ?? null,
      },
      rawStorage: storage,
      alerts,
      captureOnly,
      normalInboundDeliveryEnabled,
      captureQueueId,
      captureMaxMessages,
      captureTarget,
      checkedAt: suppliedNow,
    };
  }
}
