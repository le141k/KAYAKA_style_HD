import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
  Optional,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ImapFlow } from 'imapflow';
import type { AddressObject, ParsedMail } from 'mailparser';
import { TicketsService } from '../tickets/tickets.service';
import { MailService } from './mail.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptField } from '../../common/field-encrypt.util';
import { normalizeEmail } from '../../common/email.util';
import { stripQuotedReply } from './quoted-reply.util';
import { Prisma, type EmailParserRule } from '@prisma/client';
import { normalizePipeDeliveryId } from './pipe-input.util';
import { InboundRawStorageService } from './inbound-raw-storage.service';
import { isKnownUnsafeCaptureMailbox, readCanonicalImapMailbox } from './dto';

/** Parsed email fields used for rule evaluation */
interface ParsedEmail {
  subject: string;
  fromEmail: string;
  fromName: string;
  toEmail?: string;
  body: string;
}

/** Result of applyParserRules */
export interface ParserRuleResult {
  skip: boolean;
  departmentId?: number;
  priorityId?: number;
  ownerStaffId?: number;
  tags: string[];
}

/** Terminal outcome of processing one raw inbound message. */
interface ProcessOutcome {
  state: 'PROCESSED' | 'SKIPPED';
  ticketId?: number;
  postId?: number;
}

/** Immutable business route selected before a delivery can create a ticket. */
interface InboundRoute {
  queueId?: number;
  departmentId?: number;
  /** Customer-automation policy of the queue that actually owns this ticket. */
  sendAutoresponder?: boolean;
  /** No configured recipient address matched; receiving queue/default was used explicitly. */
  fallback: boolean;
  fallbackReason?: 'RECEIVING_QUEUE' | 'DEFAULT_DEPARTMENT';
}

/**
 * Immutable enabled-queue view captured in the same transaction as ledger acceptance.
 * It lets every CC/BCC transport copy make the documented priority decision without
 * consulting configuration that an operator may have changed while the delivery waited
 * in the ledger.
 */
interface RoutingSnapshotEntry {
  id: number;
  emailAddress: string;
  departmentId: number | null;
  routingPriority: number;
  sendAutoresponder: boolean;
}

/** Context snapshotted from the ledger row, never inferred from mutable queue state later. */
interface DeliveryRoutingContext {
  queueId?: number;
  transportKey?: string;
  envelopeTo?: string;
  routedQueueId?: number;
  routedDepartmentId?: number;
  sendAutoresponder?: boolean | null;
  routingSnapshot?: RoutingSnapshotEntry[];
}

interface LogicalClaimWinner {
  messageIdHash: string;
  /** Exact logical-content fence for sibling owner propagation. */
  semanticHash: string;
  route: InboundRoute;
}

type LogicalClaimResult =
  | { kind: 'WINNER'; winner: LogicalClaimWinner }
  | { kind: 'DUPLICATE'; route: InboundRoute; ticketId: number | null }
  | { kind: 'CONFLICT'; route: InboundRoute; existingSemanticHash: string | null };

/** Raw MIME representation held until the acceptance transaction commits or rolls back. */
type PersistedRawMime = {
  rawMime: Uint8Array<ArrayBuffer> | null;
  rawStorageKey: string | null;
};

/**
 * A real Message-ID was reused with different logical content, or points at a legacy claim
 * whose semantic content cannot be reconstructed safely. This is an input/forensics conflict,
 * not a transient DB error, so the delivery is quarantined (with its raw MIME retained).
 */
class SemanticMessageIdConflictError extends BadRequestException {
  constructor(message: string) {
    super(message);
  }
}

/**
 * A ticket may already exist while the delivery's ACL owner has not been durably fenced to it.
 * Retrying that state under a stale route would expose raw MIME to the wrong department, so the
 * caller must reset the owner to UNRESOLVED in the same lease-fenced terminal transition.
 */
class EffectiveOwnerResolutionError extends ServiceUnavailableException {
  constructor(deliveryId: number) {
    super(`Inbound delivery ${deliveryId} could not persist its effective owner`);
    this.name = 'EffectiveOwnerResolutionError';
  }
}

/** Immutable DB snapshot handed from the reconcile CAS to the IMAP probe. */
export interface ReconcileMailboxSnapshot {
  id: number;
  host: string;
  port: number;
  username: string;
  passwordEnc: string;
  useTls: boolean;
  /** Exact IMAP folder whose UIDVALIDITY/UIDNEXT baseline is being reconciled. */
  mailbox: string;
  mailboxEpoch: number;
  cursorGeneration: number;
  configGeneration: number;
}

/** Exact IMAP snapshot used to complete FROM_NOW/BACKFILL. */
export interface ReconcileMailboxBaseline {
  uidValidity: bigint;
  /** UIDNEXT - 1 observed while the mailbox lock was held. */
  boundary: number;
  /** Durable cursor: boundary for FROM_NOW, predecessor of the selected N UIDs for BACKFILL. */
  cursor: number;
  /** Existing UID values selected for BACKFILL; empty for FROM_NOW. */
  selectedUids: number[];
}

/** The queue changed after a poll fetched bytes but before it could durably accept them. */
class StaleImapAcceptSnapshotError extends Error {
  constructor(queueId: number) {
    super(`IMAP queue ${queueId} changed before delivery acceptance`);
    this.name = 'StaleImapAcceptSnapshotError';
  }
}

/** A supposedly identical IMAP transport identity carried different bytes: halt, never skip. */
class ImapTransportCollisionError extends Error {
  constructor(queueId: number, transportKey: string) {
    super(`IMAP transport collision on queue ${queueId}: ${transportKey}`);
    this.name = 'ImapTransportCollisionError';
  }
}

/** Fixed poll snapshot used by the acceptance fence; never re-read mutable queue fields. */
interface ImapAcceptSnapshot {
  id: number;
  type: 'IMAP' | 'PIPE' | 'POP3';
  isEnabled: boolean;
  /** Configured receiving mailbox; persisted as the trusted envelope fallback for routing. */
  emailAddress: string;
  departmentId: number | null;
  sendAutoresponder: boolean;
  /** Queue-selected IMAP folder. Undefined only supports pre-mailbox unit fixtures. */
  mailbox?: string;
  /** Capture-only refuses a credential-bearing IMAP session unless this snapshot is TLS-enabled. */
  useTls?: boolean;
  syncState: 'OK' | 'BOOTSTRAPPING' | 'NEEDS_RECONCILIATION';
  mailboxEpoch: number;
  cursorGeneration: number;
  configGeneration: number;
  uidValidity: bigint | null;
  /** A capture-tested queue is permanently excluded from normal ingress. */
  captureRetiredAt: Date | null;
}

/** Ticket mask pattern used to thread inbound replies, e.g. TT-000042 */
const MASK_RE = /TT-\d{6,}/i;

// Parser-amplification bounds — reject pathological MIME before it reaches routing,
// storage, or the regex parser rules (preserved from the security baseline).
const MAX_SUBJECT_CHARS = 500;
const MAX_BODY_CHARS = 100_000;
const MAX_ADDRESS_CHARS = 320;
const MAX_NAME_CHARS = 200;
const MAX_FILENAME_CHARS = 255;
const MAX_MESSAGE_ID_CHARS = 512;
const MAX_REFERENCES = 50;
const MAX_REFERENCE_CHARS = 8_192;
const MAX_ADDRESSES = 100;
const MAX_ATTACHMENTS = 10;
const MAX_RULE_PATTERN_CHARS = 128;
// At most two MIME trees are materialized concurrently; excess parse work is bounded
// so a burst of large messages cannot exhaust memory.
const MAX_CONCURRENT_PARSERS = 2;
const MAX_QUEUED_PARSERS = 32;
/** Larger messages live in the existing upload volume, not forever in PostgreSQL rows. */
const MAX_INLINE_RAW_MIME_BYTES = 1024 * 1024;

/** Minimal ticket shape needed to authorize an inbound reply against its participants. */
interface ThreadableTicket {
  id: number;
  departmentId: number;
  requesterEmail: string | null;
  user?: { emails: Array<{ email: string }> } | null;
  recipients?: Array<{ email: string }>;
}

/**
 * Inbound mail service — durable, idempotent, fail-closed.
 *
 * Every inbound message (IMAP poll or POST /api/inbound/pipe) is first recorded in the
 * `InboundDelivery` ledger (state ACCEPTED, raw MIME retained) under a UNIQUE transport
 * key, then processed by the drain. This guarantees:
 *  - **No silent loss:** the IMAP cursor advances only after a message is durably
 *    ACCEPTED; a fetch/DB error stops the poll without advancing (fail-closed).
 *  - **Idempotency:** the unique transport key makes re-delivery a no-op; processing
 *    de-dups by RFC Message-ID (synthesised from the content hash when the message
 *    carries none), so a retry after a mid-processing failure never double-posts.
 *  - **Replay:** a failing message is retried with backoff, then QUARANTINED (never
 *    discarded — the raw MIME is kept) for operator replay.
 *  - **Fail-closed UIDVALIDITY:** a server UID-space reset halts the queue
 *    (NEEDS_RECONCILIATION) for an explicit operator FROM_NOW / BACKFILL decision.
 *
 * TODO: replace polling with IMAP IDLE; externalise raw MIME for very large messages.
 */
@Injectable()
export class InboundMailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundMailService.name);
  private readonly connections: Map<number, ImapFlow> = new Map();
  /** Fingerprint (host/port/tls/user/password/folder) of each live connection so the supervisor
   *  reconnects when a queue's credentials, host, or selected folder changes, not only when it drops. */
  private readonly connectionFingerprints = new Map<number, string>();
  /** A capture target becomes ready only after THIS process has checked its live
   *  IMAP LIST/special-use mapping and an empty baseline. This is deliberately
   *  in-memory: a restart must prove the mailbox again before the operator UI
   *  can invite another attended test. */
  private readonly captureReadyQueues = new Set<number>();
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private drainHandle: ReturnType<typeof setInterval> | null = null;
  private pruneHandle: ReturnType<typeof setInterval> | null = null;
  /** Refresh PIPE loop-suppression addresses even when the IMAP transport is disabled. */
  private ownAddressHandle: ReturnType<typeof setInterval> | null = null;
  /** A timer tick shares this promise with manual pollNow calls; cycles never overlap. */
  private pollAllInFlight: Promise<void> | null = null;
  /** Drain ticks share one cycle too, so shutdown can wait for claimed work to settle. */
  private drainInFlight: Promise<void> | null = null;
  /** One IMAP connection must never be polled twice concurrently in this process. */
  private readonly pollingQueues = new Set<number>();
  /** Prevent a shutdown from starting a fresh supervisor/poll cycle. */
  private stopping = false;
  /** Throttle repeated "queue halted" logs to once per interval per queue. */
  private readonly haltLogged = new Set<number>();
  /** This process's id (diagnostics). Lease ownership uses a fresh per-claim token. */
  private readonly instanceId = randomUUID();
  /** Delivery ids currently being processed IN THIS process — prevents a slow flow whose
   *  lease expired from being reclaimed and reprocessed concurrently by our own drain. */
  private readonly inFlight = new Set<number>();
  /** Bounded MIME-parse concurrency (permits + FIFO waiters), preserved from the
   *  security baseline so a burst of large messages cannot exhaust memory. */
  private activeParsers = 0;
  private readonly parserWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  /** Our own mailbox addresses (MAIL_FROM + every configured queue) for loop suppression. */
  private readonly ownAddresses = new Set<string>();
  /** How long a PROCESSING lease is honoured before another worker may reclaim it. */
  private static readonly LEASE_MS = 5 * 60_000;
  /** A raw-MIME stage may be reaped only after this lease, and only under its DB row lock. */
  private static readonly RAW_STAGING_LEASE_MS = 10 * 60_000;

  private get maxAttempts(): number {
    return this.config.TELECOM_HD_INBOUND_MAX_ATTEMPTS;
  }

  /**
   * The release/canary master gate must fail closed. `AppConfig` always supplies this
   * boolean at runtime; treating an incomplete hand-built test/config object as disabled
   * keeps a future bootstrap or direct service caller from accidentally accepting mail.
   */
  private get inboundDeliveryEnabled(): boolean {
    return this.config.TELECOM_HD_INBOUND_DELIVERY_ENABLED === true;
  }

  /** True only for the explicit, non-processing mailbox capture test mode. */
  private get inboundCaptureOnlyEnabled(): boolean {
    return this.config.TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED === true;
  }

  /** A capture queue must be explicit; an incomplete hand-built config fails closed. */
  private get captureQueueId(): number | null {
    const value = this.config.TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID;
    return Number.isInteger(value) && value! > 0 ? value! : null;
  }

  /** Capture-only is exactly one message; any other hand-built config is a closed gate. */
  private get captureMaxMessages(): number {
    const value = this.config.TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES;
    return value === 1 ? 1 : 0;
  }

  /** Queue side of the promotion-only normal-delivery canary fence. */
  private get normalDeliveryCanaryQueueId(): number | null {
    const value = this.config.TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID;
    return Number.isSafeInteger(value) && value! > 0 ? value! : null;
  }

  /** Immutable captured-delivery side of the normal-delivery canary fence. */
  private get normalDeliveryCanaryDeliveryId(): number | null {
    const value = this.config.TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID;
    return Number.isSafeInteger(value) && value! > 0 ? value! : null;
  }

  private get normalDeliveryCanaryConfigured(): boolean {
    return this.normalDeliveryCanaryQueueId !== null || this.normalDeliveryCanaryDeliveryId !== null;
  }

  /** A hand-built/partial config fails closed even before loadConfig rejects it. */
  private get normalDeliveryCanary(): { queueId: number; deliveryId: number } | null {
    const queueId = this.normalDeliveryCanaryQueueId;
    const deliveryId = this.normalDeliveryCanaryDeliveryId;
    return queueId !== null && deliveryId !== null ? { queueId, deliveryId } : null;
  }

  /** The one queue which is allowed to be touched by the active attended mode. */
  private get activeInboundQueueId(): number | null {
    if (this.inboundCaptureOnlyEnabled) return this.captureQueueId;
    // A normal canary is promotion-only: do not establish/poll IMAP at all.
    // Its selected CAPTURED delivery enters through the audited promotion endpoint.
    return null;
  }

  /** A capture-only accept path must never run with a credential-encryption fallback. */
  private get captureEncryptionReady(): boolean {
    const key = this.config.TELECOM_HD_FIELD_ENCRYPTION_KEY;
    return typeof key === 'string' && /^[0-9a-f]{64}$/i.test(key);
  }

  /** IMAP acceptance is allowed for normal delivery OR the one-queue capture mode. PIPE is normal-mode only. */
  private get inboundAcceptanceEnabled(): boolean {
    return (
      this.inboundDeliveryEnabled ||
      (this.inboundCaptureOnlyEnabled &&
        this.captureQueueId !== null &&
        this.captureEncryptionReady &&
        this.captureMaxMessages === 1)
    );
  }

  /** Only normal delivery may parse/rule-route/create tickets or enqueue mail. */
  private get inboundProcessingEnabled(): boolean {
    return this.inboundDeliveryEnabled && !this.inboundCaptureOnlyEnabled;
  }

  private acceptsQueue(queueId: number): boolean {
    if (this.inboundCaptureOnlyEnabled) {
      return this.captureQueueId !== null && this.captureQueueId === queueId;
    }
    // The normal canary must never accept a new IMAP/PIPE delivery. It may only
    // drain the one pre-existing CAPTURED row named by its immutable selector.
    if (this.normalDeliveryCanaryConfigured) return false;
    return true;
  }

  /**
   * Bound capture-only storage while the selected EmailQueue row is already locked by
   * acceptance. That makes the count a real cross-process admission fence for IMAP,
   * rather than a racy advisory dashboard number. Exact transport retries are
   * recognized before this check so an MTA/IMAP retry remains idempotent at capacity.
   */
  private async assertCaptureCapacity(tx: Prisma.TransactionClient, queueId: number): Promise<void> {
    if (!this.inboundCaptureOnlyEnabled) return;
    const limit = this.captureMaxMessages;
    if (limit < 1) {
      throw new ServiceUnavailableException('Inbound capture-only capacity is not configured safely');
    }
    const captured = await tx.inboundDelivery.count({
      // A truncated IMAP source is safely QUARANTINED at acceptance, but its raw
      // bytes are retained just like CAPTURED. Counting it closes the otherwise
      // unlimited oversized-message bypass of the one-message test boundary.
      where: { queueId, state: { in: ['CAPTURED', 'QUARANTINED'] } },
    });
    if (captured >= limit) {
      throw new ServiceUnavailableException(
        'Inbound capture-only limit is reached; review the captured message and stop or reconfigure the test queue before accepting another',
      );
    }
  }

  /**
   * An advisory outer fence for IMAP polling.  The transactional check above is the
   * authoritative cross-pod admission control; this one deliberately runs before
   * `fetchOne()` so an already full one-message test does not keep downloading and
   * briefly staging every later raw MIME from the selected mailbox on each poll.
   *
   * A known transport key remains eligible for a body fetch: it can be an interrupted
   * exact retry whose hash must be verified before the cursor is allowed to advance.
   * A newly discovered UID at capacity stops before any raw-body read. A concurrent
   * insert between this advisory read and acceptance is still rejected by the locked
   * transactional count, so this optimisation never widens the durable limit.
   */
  private async captureLimitReached(queueId: number): Promise<boolean> {
    if (!this.inboundCaptureOnlyEnabled) return false;
    const limit = this.captureMaxMessages;
    if (limit < 1) {
      throw new ServiceUnavailableException('Inbound capture-only capacity is not configured safely');
    }
    const captured = await this.prisma.inboundDelivery.count({
      where: { queueId, state: { in: ['CAPTURED', 'QUARANTINED'] } },
    });
    return captured >= limit;
  }

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TicketsService)) private readonly ticketsService: TicketsService,
    private readonly mailService: MailService,
    @Optional() private readonly attachmentsService?: AttachmentsService,
    @Optional() private readonly rawStorage?: InboundRawStorageService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Do not start supervisor, drain, or retention work when both normal delivery and
    // the narrowly-scoped capture mode are closed. ACCEPTED/RETRY ledger rows remain
    // durable and operator endpoints remain available; an attended configuration-only
    // restart is required before processing.
    if (!this.inboundAcceptanceEnabled) {
      this.logger.warn(
        'Inbound acceptance disabled — IMAP, PIPE acceptance, and ledger drain are fail-closed',
      );
      return;
    }

    // Seed loop-suppression addresses (our MAIL_FROM + every enabled queue) BEFORE the
    // TELECOM_HD_IMAP_ENABLED early-return, so a self-loop is suppressed even when the
    // poller is disabled and mail arrives only via the PIPE webhook. The set is rebuilt on
    // every supervisor cycle (reconcileConnections) so a queue address change is reflected.
    await this.refreshOwnAddresses();
    this.ownAddressHandle = setInterval(() => {
      void this.refreshOwnAddresses();
    }, 60_000);
    this.ownAddressHandle.unref?.();

    // Capture-only is IMAP-folder-only by design. In normal mode, surface enabled
    // non-IMAP queues rather than silently ignoring their MTA/PIPE ingress route.
    if (!this.inboundCaptureOnlyEnabled) {
      const nonImap = await this.prisma.emailQueue.findMany({
        where: { isEnabled: true, type: { not: 'IMAP' } },
        select: { id: true, emailAddress: true, type: true },
      });
      for (const q of nonImap) {
        this.logger.warn(
          `EmailQueue ${q.id} (${q.emailAddress}, type=${q.type}) is enabled but not IMAP — ` +
            `the poller will not fetch it. Use the inbound webhook (POST /api/inbound/pipe) for PIPE/MTA delivery.`,
        );
      }
    }

    // The drain runs regardless of IMAP in NORMAL delivery mode so PIPE RETRY
    // deliveries make progress. Capture-only is intentionally a durable hold: it must
    // not reclaim old ACCEPTED/RETRY rows or process a newly CAPTURED row on startup.
    if (this.inboundProcessingEnabled) {
      this.drainHandle = setInterval(() => {
        void this.drainDeliveries().catch((err: unknown) =>
          this.logger.error(`Inbound drain error (${this.errorKind(err)})`),
        );
      }, 30_000);
      void this.drainDeliveries().catch((err: unknown) =>
        this.logger.error(`Inbound startup drain error (${this.errorKind(err)})`),
      );
    } else {
      this.logger.warn(
        `Inbound capture-only active for queue ${this.captureQueueId}: ledger drain and ticket processing are disabled`,
      );
    }

    // Capture-only must be a read-isolated, one-message experiment.  The normal
    // retention/reaper pass can delete or alter raw storage belonging to old terminal
    // deliveries in the same development database, so do not start it in this mode.
    // It resumes only after the attended test is closed and the API is restarted.
    if (!this.inboundCaptureOnlyEnabled && !this.normalDeliveryCanaryConfigured) {
      // Raw-MIME retention: prune terminal deliveries' inline blobs hourly (and once now) so the
      // ledger's on-disk footprint stays bounded. Independent of IMAP (PIPE deliveries too).
      this.pruneHandle = setInterval(() => {
        void this.pruneRawMime().catch((err: unknown) =>
          this.logger.error(`Inbound retention prune error (${this.errorKind(err)})`),
        );
      }, 60 * 60_000);
      this.pruneHandle.unref?.();
      void this.pruneRawMime().catch((err: unknown) =>
        this.logger.error(`Inbound startup retention prune error (${this.errorKind(err)})`),
      );
    } else {
      this.logger.warn(
        this.inboundCaptureOnlyEnabled
          ? 'Inbound capture-only active: global raw-MIME retention and reapers are disabled'
          : `Inbound normal-delivery canary active for delivery ${this.normalDeliveryCanaryDeliveryId}: ` +
              'global raw-MIME retention and reapers are disabled',
      );
    }

    if (!this.config.TELECOM_HD_IMAP_ENABLED) {
      this.logger.log(
        `IMAP polling disabled (TELECOM_HD_IMAP_ENABLED=false) — ` +
          `${this.inboundProcessingEnabled ? 'drain active for PIPE' : 'IMAP capture-only cannot start until polling is enabled'}`,
      );
      return;
    }

    if (this.normalDeliveryCanaryConfigured) {
      const canary = this.normalDeliveryCanary;
      if (!canary) {
        this.logger.error(
          'Inbound normal-delivery canary configuration is incomplete; IMAP acceptance remains fail-closed',
        );
      } else {
        this.logger.log(
          `Inbound normal-delivery canary active for captured delivery ${canary.deliveryId} in queue ${canary.queueId}: ` +
            'IMAP/PIPE acceptance is disabled; only the audited promotion may enter the drain',
        );
      }
      return;
    }

    const activeQueueId = this.activeInboundQueueId;
    const queues = await this.prisma.emailQueue.findMany({
      where: {
        isEnabled: true,
        type: 'IMAP',
        ...(this.inboundCaptureOnlyEnabled ? {} : { captureRetiredAt: null }),
        ...(activeQueueId !== null ? { id: activeQueueId } : {}),
      },
    });

    // Connect any queues that exist now. Do NOT early-return when there are zero — the
    // poll supervisor below (reconcileConnections, run each cycle) connects queues created
    // or enabled AFTER startup, so a first IMAP queue added at runtime is polled without an
    // API restart (previously a zero-queue boot left the supervisor unstarted forever).
    const encKey = this.config.TELECOM_HD_FIELD_ENCRYPTION_KEY;
    for (const queue of queues) {
      try {
        this.captureMailbox(queue);
      } catch (err) {
        this.logger.error(`IMAP queue ${queue.id}: capture mailbox refused (${this.errorKind(err)})`);
        await this.stampQueue(queue.id, {
          lastConnectionErrorAt: new Date(),
          lastError: 'Capture-only requires a TLS-enabled, canonical dedicated IMAP test folder',
        });
        continue;
      }
      let plainPassword: string;
      try {
        plainPassword = decryptField(queue.passwordEnc, encKey);
      } catch (err) {
        this.logger.error(`Failed to decrypt IMAP password for queue ${queue.id} (${this.errorKind(err)})`);
        continue;
      }
      await this.connectQueue(queue.id, {
        host: queue.host,
        port: queue.port,
        secure: queue.useTls,
        auth: { user: queue.username, pass: plainPassword },
      });
      if (this.connections.has(queue.id)) {
        this.connectionFingerprints.set(queue.id, this.connectionFingerprint(queue));
      }
    }

    this.pollHandle = setInterval(() => {
      void this.pollNow().catch((err: unknown) =>
        this.logger.error(`IMAP poll error (${this.errorKind(err)})`),
      );
    }, 60_000);

    this.logger.log(
      `IMAP inbound polling supervisor started (${queues.length} queue(s) connected at boot; ` +
        `${
          this.inboundCaptureOnlyEnabled
            ? `capture queue ${this.captureQueueId} only`
            : 'reconnects + newly enabled queues handled each cycle'
        })`,
    );
  }

  /**
   * Rebuild the self-loop suppression set from the CURRENT enabled queues (+ MAIL_FROM).
   * Called at init and on every supervisor cycle so an emailAddress change — which does not
   * change a connection fingerprint — is reflected without an API restart. Replaces the set
   * atomically (no await between clear and refill) and keeps the old set on a DB error
   * rather than blanking loop suppression.
   */
  private async refreshOwnAddresses(): Promise<void> {
    const configuredFrom = this.normalizeConfiguredMailbox(this.config.TELECOM_HD_MAIL_FROM ?? '');
    let rows: Array<{ emailAddress: string }>;
    try {
      rows = await this.prisma.emailQueue.findMany({
        where: { isEnabled: true },
        select: { emailAddress: true },
      });
    } catch (err) {
      this.logger.error(`ownAddresses refresh failed (keeping prior set; ${this.errorKind(err)})`);
      return;
    }
    const next = new Set<string>();
    if (configuredFrom) next.add(configuredFrom);
    for (const r of rows) {
      const address = normalizeEmail(r.emailAddress);
      if (address) next.add(address);
    }
    this.ownAddresses.clear();
    for (const address of next) this.ownAddresses.add(address);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.pollHandle) clearInterval(this.pollHandle);
    if (this.drainHandle) clearInterval(this.drainHandle);
    if (this.pruneHandle) clearInterval(this.pruneHandle);
    if (this.ownAddressHandle) clearInterval(this.ownAddressHandle);
    // Let a cycle already in progress release its IMAP mailbox lock before logging out
    // connections. New ticks cannot start after `stopping = true`.
    await this.pollAllInFlight?.catch((err: unknown) =>
      this.logger.warn(`Inbound poll shutdown wait failed (${this.errorKind(err)})`),
    );
    await this.drainInFlight?.catch((err: unknown) =>
      this.logger.warn(`Inbound drain shutdown wait failed (${this.errorKind(err)})`),
    );
    // Release any queued parse waiters so pending drains reject rather than hang on shutdown.
    const shutdownError = new ServiceUnavailableException('Inbound parser is shutting down');
    for (const waiter of this.parserWaiters.splice(0)) waiter.reject(shutdownError);
    for (const [queueId, client] of this.connections) {
      try {
        await client.logout();
      } catch {
        this.logger.warn(`Error logging out IMAP queue ${queueId}`);
      }
    }
    this.connections.clear();
    this.captureReadyQueues.clear();
  }

  /**
   * Health/UI gate for an attended capture-only canary. `true` means this process
   * has an active connection that just proved the configured mailbox is a live
   * non-special empty test folder. It intentionally becomes false on every restart,
   * reconnect, disconnect, or validation failure.
   */
  isCaptureQueueReady(queueId: number): boolean {
    return this.inboundCaptureOnlyEnabled && this.captureReadyQueues.has(queueId);
  }

  // ─────────────────── connection + bootstrap ───────────────────

  private async connectQueue(
    queueId: number,
    opts: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } },
  ): Promise<void> {
    if (this.stopping) return;
    this.captureReadyQueues.delete(queueId);
    await this.stampQueue(queueId, { lastConnectionAttemptAt: new Date() });
    let client: ImapFlow | undefined;
    try {
      // Capture mode changes the queue's durable lifecycle before an authenticated
      // IMAP socket is opened.  From this point onward every normal accept/claim
      // fence rejects the queue, even if a process is restarted with capture mode
      // disabled.  If normal work is already pending, arming fails rather than
      // racing it into an ambiguous state.
      const captureArmedNow = this.inboundCaptureOnlyEnabled
        ? await this.armCaptureQueueForConnection(queueId)
        : false;
      const { ImapFlow: ImapFlowCtor } = await import('imapflow');
      client = new ImapFlowCtor({
        host: opts.host,
        port: opts.port,
        secure: opts.secure,
        auth: opts.auth,
        logger: false,
      });
      await client.connect();
      this.connections.set(queueId, client);
      // Capture the baseline SYNCHRONOUSLY at activation (not on the first 60s poll) so
      // mail arriving between connect and the first poll is not skipped (P0-2).
      await this.bootstrapQueue(queueId, client, { captureArmedNow });
      await this.stampQueue(queueId, {
        lastConnectedAt: new Date(),
        ...(this.inboundCaptureOnlyEnabled ? { lastError: null } : {}),
      });
      if (this.inboundCaptureOnlyEnabled) this.captureReadyQueues.add(queueId);
      this.logger.log(`IMAP connected to queue ${queueId} (${opts.host}:${opts.port})`);
    } catch (err) {
      // A connect can succeed while the synchronous baseline fails. Do not retain a
      // half-initialised socket: it would look live to the supervisor and might be
      // polled without a durable bootstrap boundary on the next cycle.
      if (client && this.connections.get(queueId) === client) {
        this.connections.delete(queueId);
        this.connectionFingerprints.delete(queueId);
        try {
          await client.logout();
        } catch {
          // The socket is already removed from our registry; the next supervisor
          // cycle will establish a fresh connection regardless of LOGOUT result.
        }
      }
      this.captureReadyQueues.delete(queueId);
      // Driver errors may embed a connection URI or authentication detail. Queue health
      // carries a safe state; logs retain only the error class and queue id.
      this.logger.error(`Failed to connect IMAP queue ${queueId} (${this.errorKind(err)})`);
      await this.stampQueue(queueId, {
        lastConnectionErrorAt: new Date(),
        lastDisconnectedAt: new Date(),
        lastError: 'IMAP connection failed; verify queue configuration and server availability',
      });
    }
  }

  /**
   * Capture the exact server-side boundary for an operator reconcile.  This runs before
   * the endpoint returns success; it never delegates a FROM_NOW decision to the next
   * sixty-second poll.  A matching live connection is safe to reuse, otherwise a short
   * connection is made from the CAS snapshot's credentials so a stale pre-update socket
   * can never establish a new mailbox baseline.
   */
  async captureReconcileBaseline(
    snapshot: ReconcileMailboxSnapshot,
    mode: 'FROM_NOW' | 'BACKFILL',
    backfillLimit: number,
  ): Promise<ReconcileMailboxBaseline> {
    const mailbox = this.captureMailbox(snapshot);
    const expectedFingerprint = this.connectionFingerprint(snapshot);
    let client = this.connections.get(snapshot.id);
    let temporary = false;
    if (
      !client ||
      (client as { usable?: boolean }).usable === false ||
      this.connectionFingerprints.get(snapshot.id) !== expectedFingerprint
    ) {
      let pass: string;
      try {
        pass = decryptField(snapshot.passwordEnc, this.config.TELECOM_HD_FIELD_ENCRYPTION_KEY);
      } catch (err) {
        this.logger.error(
          `IMAP reconcile credential decrypt failed for queue ${snapshot.id} (${this.errorKind(err)})`,
        );
        // The durable queue error/health endpoint is operator-visible.  Do not persist
        // driver text here: it can contain a hostname, username, or authentication detail.
        throw new ServiceUnavailableException('IMAP credentials could not be decrypted');
      }
      try {
        const { ImapFlow: ImapFlowCtor } = await import('imapflow');
        client = new ImapFlowCtor({
          host: snapshot.host,
          port: snapshot.port,
          secure: snapshot.useTls,
          auth: { user: snapshot.username, pass },
          logger: false,
        });
        await client.connect();
        temporary = true;
      } catch (err) {
        this.logger.error(
          `IMAP reconcile connection failed for queue ${snapshot.id} (${this.errorKind(err)})`,
        );
        throw new ServiceUnavailableException('Unable to connect to IMAP mailbox');
      }
    }

    const active = client;
    if (!active) throw new ServiceUnavailableException('IMAP client was not created');
    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>> | undefined;
    let captureSafetyFailure = false;
    try {
      await this.assertDedicatedCaptureMailbox(active, mailbox);
      lock = await active.getMailboxLock(mailbox);
      const { uidValidity, uidNext, exists } = this.readMailboxState(active);
      this.assertEmptyCaptureMailbox(exists);
      // UIDNEXT is the only permitted FROM_NOW boundary.  EXISTS is a message count and
      // fetch('*') races with arrivals; neither is an equivalent replacement.
      if (
        uidValidity === undefined ||
        uidNext === undefined ||
        !Number.isSafeInteger(uidNext) ||
        uidNext < 1
      ) {
        throw new ServiceUnavailableException(
          'IMAP server did not provide a valid UIDVALIDITY/UIDNEXT snapshot',
        );
      }
      const boundary = uidNext - 1;
      if (mode === 'FROM_NOW') {
        return { uidValidity, boundary, cursor: boundary, selectedUids: [] };
      }
      if (!Number.isSafeInteger(backfillLimit) || backfillLimit < 1) {
        throw new BadRequestException('BACKFILL requires a positive bounded UID count');
      }

      // SEARCH under the SAME mailbox lock gives actual existing UIDs.  They can be sparse
      // after EXPUNGE, so `boundary - N` is not a valid backfill boundary.  Filtering at the
      // captured UIDNEXT boundary excludes mail delivered after the snapshot; it will be
      // fetched normally once the durable cursor is committed.
      const found = boundary === 0 ? [] : await active.search({ uid: `1:${boundary}` }, { uid: true });
      if (found === false) throw new ServiceUnavailableException('IMAP SEARCH did not return a UID set');
      const selectedUids = found
        .filter(
          (uid): uid is number =>
            typeof uid === 'number' && Number.isSafeInteger(uid) && uid > 0 && uid <= boundary,
        )
        .sort((a, b) => a - b)
        .slice(-backfillLimit);
      const oldestSelected = selectedUids[0];
      const cursor = oldestSelected === undefined ? boundary : oldestSelected - 1;
      return { uidValidity, boundary, cursor, selectedUids };
    } catch (err) {
      // A reused supervisor connection may have been opened before an operator changed
      // the configured folder into a special-use/non-empty target. Do not leave that
      // authenticated socket alive after refusing the capture boundary.
      captureSafetyFailure = this.inboundCaptureOnlyEnabled;
      throw err;
    } finally {
      try {
        lock?.release();
      } finally {
        if (temporary) {
          try {
            await active.logout();
          } catch {
            // The baseline is already captured; a failed LOGOUT must not change it.
          }
        } else if (captureSafetyFailure) {
          await this.dropLiveConnection(snapshot.id, active);
        }
      }
    }
  }

  /**
   * Record the starting cursor for a never-bootstrapped queue (uidValidity IS NULL).
   * FROM_NOW records the current high-water UID and imports nothing; BACKFILL rewinds
   * the cursor by up to TELECOM_HD_IMAP_BACKFILL_LIMIT so the most-recent existing
   * messages are ingested. Never fails open to `1:*`.
   */
  private async bootstrapQueue(
    queueId: number,
    client: ImapFlow,
    options: { captureArmedNow?: boolean } = {},
  ): Promise<void> {
    let queue = await this.prisma.emailQueue.findUnique({ where: { id: queueId } });
    if (!queue || queue.type !== 'IMAP' || !queue.isEnabled) return;
    if (queue.captureRetiredAt != null && !this.inboundCaptureOnlyEnabled) {
      this.logger.warn(`IMAP queue ${queueId}: capture-retired queue is excluded from normal bootstrap`);
      return;
    }
    const mailbox = this.captureMailbox(queue);
    // A queue can already have a normal-mode cursor when capture-only is enabled by
    // restart. Do not let the old `uidValidity !== null` early-return bypass the
    // dedicated-folder/empty-folder proof for that first capture-only connection.
    let captureArmedNow = options.captureArmedNow === true;
    if (this.inboundCaptureOnlyEnabled) {
      if (queue.captureRetiredAt == null) {
        if (!captureArmedNow) captureArmedNow = await this.armCaptureQueue(queue, mailbox);
        // The marker was committed in armCaptureQueue's transaction. Keep the
        // immutable snapshot local rather than re-reading a potentially stale
        // replica between arming and the UIDNEXT baseline.
        queue = { ...queue, captureRetiredAt: new Date() };
      }
      await this.assertDedicatedCaptureMailbox(client, mailbox);
      const captureLock = await client.getMailboxLock(mailbox);
      try {
        const { exists } = this.readMailboxState(client);
        // The empty-folder proof applies to the first arm only.  After an armed
        // capture worker reconnects, the one intended message may already be in the
        // folder; requiring emptiness again would strand it without improving safety.
        if (captureArmedNow) this.assertEmptyCaptureMailbox(exists);
      } finally {
        captureLock.release();
      }
    }
    if (!queue) return;
    if (queue.uidValidity !== null) return; // already bootstrapped
    if (queue.syncState === 'NEEDS_RECONCILIATION') {
      // Halted (e.g. upgraded from a legacy cursor) — never auto-FROM_NOW over it; an
      // operator must reconcile explicitly (choose FROM_NOW or a bounded BACKFILL).
      this.logger.warn(
        `IMAP queue ${queueId}: NEEDS_RECONCILIATION — bootstrap skipped (operator action required)`,
      );
      return;
    }
    // Explicit P0-B reconcile owns BOOTSTRAPPING and commits its UIDNEXT baseline
    // synchronously.  The background supervisor may bootstrap only a brand-new healthy
    // queue; it must never complete a failed/in-progress operator request behind their back.
    if (queue.syncState !== 'OK' || queue.reconcileCause !== null) return;
    await this.assertDedicatedCaptureMailbox(client, mailbox);
    const lock = await client.getMailboxLock(mailbox);
    try {
      const { uidValidity, uidNext, exists } = this.readMailboxState(client);
      // A capture queue with no durable UIDNEXT baseline must still prove an empty
      // folder.  Once a baseline exists, reconnects deliberately allow the one
      // expected message to be present for polling.
      if (!this.inboundCaptureOnlyEnabled || queue.uidValidity === null)
        this.assertEmptyCaptureMailbox(exists);
      if (
        uidValidity === undefined ||
        uidNext === undefined ||
        !Number.isSafeInteger(uidNext) ||
        uidNext < 1
      ) {
        this.logger.warn(
          `IMAP queue ${queueId}: server did not advertise a valid UIDVALIDITY/UIDNEXT — bootstrap deferred`,
        );
        return;
      }
      const boundary = uidNext - 1;
      // A per-queue reconcile intent (bootstrapPolicy) overrides the global policy for
      // THIS bootstrap so the mode an operator chose at reconcile time is honoured.
      const policy = queue.bootstrapPolicy ?? this.config.TELECOM_HD_IMAP_BOOTSTRAP_POLICY;
      const backfill =
        policy === 'BACKFILL'
          ? (queue.bootstrapBackfillLimit ?? this.config.TELECOM_HD_IMAP_BACKFILL_LIMIT)
          : 0;
      let baseline = boundary;
      let selectedUids: number[] = [];
      if (policy === 'BACKFILL') {
        if (!Number.isSafeInteger(backfill) || backfill < 1) {
          this.logger.warn(`IMAP queue ${queueId}: BACKFILL requires a positive bounded UID count`);
          return;
        }
        // UID values are sparse after EXPUNGE. Select the last N *existing* UIDs
        // under the same lock rather than using `UIDNEXT - N`, which can skip mail.
        const found = boundary === 0 ? [] : await client.search({ uid: `1:${boundary}` }, { uid: true });
        if (found === false) {
          this.logger.warn(`IMAP queue ${queueId}: bootstrap SEARCH did not return a UID set`);
          return;
        }
        selectedUids = [
          ...new Set(
            found.filter(
              (uid): uid is number =>
                typeof uid === 'number' && Number.isSafeInteger(uid) && uid > 0 && uid <= boundary,
            ),
          ),
        ]
          .sort((a, b) => a - b)
          .slice(-backfill);
        baseline = selectedUids[0] === undefined ? boundary : selectedUids[0] - 1;
      }
      // CAS on uidValidity IS NULL so two pods bootstrapping the same fresh queue can't
      // write different baselines — the first wins, the loser's updateMany matches 0 rows.
      // Also gate on `cursorGeneration` (read in the same snapshot): if an operator
      // reconciled between our read and this write (bumping the generation and possibly
      // choosing a different policy), our stale baseline/policy matches 0 rows and their
      // newer intent stands. The per-queue override is consumed here (cleared).
      const cas = await this.prisma.emailQueue.updateMany({
        // Only a never-bootstrapped, non-halted queue is a valid bootstrap target: gate on
        // uidValidity IS NULL + the read generation + syncState ∈ {OK, BOOTSTRAPPING}. A
        // queue halted (NEEDS_RECONCILIATION) between our read and this write is excluded, so
        // bootstrap flips syncState → OK only from the transient/never-bootstrapped states.
        where: {
          id: queueId,
          type: 'IMAP',
          isEnabled: true,
          uidValidity: null,
          cursorGeneration: queue.cursorGeneration,
          mailboxEpoch: queue.mailboxEpoch,
          configGeneration: queue.configGeneration,
          mailbox,
          syncState: 'OK',
          reconcileCause: null,
          ...(this.inboundCaptureOnlyEnabled
            ? { captureRetiredAt: { not: null } }
            : { captureRetiredAt: null }),
        },
        data: {
          lastSeenUid: BigInt(baseline),
          uidValidity,
          syncState: 'OK',
          lastError: null,
          bootstrapPolicy: null,
          bootstrapBackfillLimit: null,
        },
      });
      if (cas.count === 0) {
        this.logger.log(`IMAP queue ${queueId}: bootstrap already done by another worker`);
        return;
      }
      this.logger.log(
        `IMAP queue ${queueId}: bootstrap ${policy} at uid=${baseline} ` +
          `(boundary=${boundary}, selected=${selectedUids.join(',') || 'none'}, uidValidity=${uidValidity})`,
      );
    } finally {
      lock.release();
    }
  }

  // ─────────────────── accept phase (IMAP poll) ───────────────────

  /**
   * Run one full accept+drain cycle across all connected queues immediately. Exposed
   * for operator "poll now" actions and live-IMAP (GreenMail/Dovecot) verification;
   * the 60s interval calls the same path.
   */
  async pollNow(): Promise<void> {
    if (!this.inboundAcceptanceEnabled) return;
    await this.pollAll();
  }

  private pollAll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.pollAllInFlight) return this.pollAllInFlight;

    const cycle = this.runPollAll().finally(() => {
      if (this.pollAllInFlight === cycle) this.pollAllInFlight = null;
    });
    this.pollAllInFlight = cycle;
    return cycle;
  }

  private async runPollAll(): Promise<void> {
    if (!this.inboundAcceptanceEnabled) return;
    await this.reconcileConnections();
    for (const [queueId, client] of this.connections) {
      try {
        await this.pollQueue(queueId, client);
      } catch (err) {
        this.logger.error(`IMAP poll failed for queue ${queueId} (${this.errorKind(err)})`);
      }
      // Drop an unusable (dropped) connection so reconcileConnections reconnects it.
      if ((client as { usable?: boolean }).usable === false) {
        this.connections.delete(queueId);
        this.connectionFingerprints.delete(queueId);
        this.captureReadyQueues.delete(queueId);
        await this.stampQueue(queueId, { lastDisconnectedAt: new Date() });
        this.logger.warn(`IMAP queue ${queueId}: connection dropped — will reconnect next cycle`);
      }
    }
    // In capture-only mode CAPTURED is a durable hold; never wake the normal drain
    // merely because a supervisor poll finished.
    if (this.inboundProcessingEnabled) await this.drainDeliveries();
  }

  /**
   * Supervisor: keep live connections in sync with the enabled IMAP queues without an
   * API restart — connect any enabled queue that has no live connection (first run,
   * reconnect after a drop, or a newly enabled/created queue), and log out + drop
   * connections for queues that were disabled or deleted.
   */
  private async reconcileConnections(): Promise<void> {
    // Rebuild loop-suppression addresses each cycle so a queue's emailAddress change (which
    // does not alter its connection fingerprint) is reflected without an API restart.
    await this.refreshOwnAddresses();
    if (!this.inboundAcceptanceEnabled || !this.config.TELECOM_HD_IMAP_ENABLED || this.stopping) return;
    if (this.normalDeliveryCanaryConfigured) {
      // A configuration-only restart normally has no inherited sockets, but
      // close any test/directly-injected connection defensively: this mode may
      // promote one stored delivery and must not poll a mailbox at all.
      for (const [queueId, client] of this.connections) {
        await this.dropLiveConnection(queueId, client);
      }
      return;
    }
    let enabled: Array<{
      id: number;
      emailAddress: string;
      host: string;
      port: number;
      useTls: boolean;
      username: string;
      passwordEnc: string;
      mailbox: string;
      captureRetiredAt: Date | null;
    }>;
    try {
      const activeQueueId = this.activeInboundQueueId;
      enabled = await this.prisma.emailQueue.findMany({
        where: {
          isEnabled: true,
          type: 'IMAP',
          ...(this.inboundCaptureOnlyEnabled ? {} : { captureRetiredAt: null }),
          ...(activeQueueId !== null ? { id: activeQueueId } : {}),
        },
        select: {
          id: true,
          emailAddress: true,
          host: true,
          port: true,
          useTls: true,
          username: true,
          passwordEnc: true,
          mailbox: true,
          captureRetiredAt: true,
        },
      });
    } catch (err) {
      this.logger.error(`IMAP reconcile query failed (${this.errorKind(err)})`);
      return;
    }
    const enabledIds = new Set(enabled.map((q) => q.id));

    // Disconnect queues no longer enabled.
    for (const [queueId, client] of this.connections) {
      if (!enabledIds.has(queueId)) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
        this.connections.delete(queueId);
        this.connectionFingerprints.delete(queueId);
        this.captureReadyQueues.delete(queueId);
        await this.stampQueue(queueId, { lastDisconnectedAt: new Date() });
        this.logger.log(`IMAP queue ${queueId}: disabled/removed — disconnected`);
      }
    }

    // Connect enabled queues with no live connection, and RECONNECT ones whose
    // host/credentials changed (a stale connection would keep polling the old server).
    const encKey = this.config.TELECOM_HD_FIELD_ENCRYPTION_KEY;
    for (const q of enabled) {
      try {
        this.captureMailbox(q);
      } catch (err) {
        this.logger.error(`IMAP queue ${q.id}: capture mailbox refused (${this.errorKind(err)})`);
        await this.dropLiveConnection(q.id, this.connections.get(q.id));
        await this.stampQueue(q.id, {
          lastConnectionErrorAt: new Date(),
          lastError: 'Capture-only requires a TLS-enabled, canonical dedicated IMAP test folder',
        });
        continue;
      }
      const fingerprint = this.connectionFingerprint(q);
      if (this.connections.has(q.id)) {
        if (this.connectionFingerprints.get(q.id) === fingerprint) continue; // unchanged
        const stale = this.connections.get(q.id);
        try {
          await stale?.logout();
        } catch {
          /* ignore */
        }
        this.connections.delete(q.id);
        this.connectionFingerprints.delete(q.id);
        this.captureReadyQueues.delete(q.id);
        await this.stampQueue(q.id, { lastDisconnectedAt: new Date() });
        this.logger.log(`IMAP queue ${q.id}: connection settings changed — reconnecting`);
      }
      let plainPassword: string;
      try {
        plainPassword = decryptField(q.passwordEnc, encKey);
      } catch (err) {
        this.logger.error(`Failed to decrypt IMAP password for queue ${q.id} (${this.errorKind(err)})`);
        continue;
      }
      await this.connectQueue(q.id, {
        host: q.host,
        port: q.port,
        secure: q.useTls,
        auth: { user: q.username, pass: plainPassword },
      });
      // Only fingerprint a connection that actually established (connectQueue swallows
      // connect errors) so a failed connect is retried next cycle. (Self-loop addresses are
      // rebuilt for ALL enabled queues at the top of this cycle by refreshOwnAddresses.)
      if (this.connections.has(q.id)) {
        this.connectionFingerprints.set(q.id, fingerprint);
      }
    }
  }

  /** Stable fingerprint of a queue's connection settings + selected folder (drives reconnect-on-change). */
  private connectionFingerprint(q: {
    host: string;
    port: number;
    useTls: boolean;
    username: string;
    passwordEnc: string;
    mailbox?: string | null;
  }): string {
    const mailbox = this.selectedMailbox(q);
    return createHash('sha256')
      .update(
        `${q.host}\u0000${q.port}\u0000${q.useTls}\u0000${q.username}\u0000${q.passwordEnc}\u0000${mailbox}`,
      )
      .digest('hex');
  }

  /**
   * Resolve the queue-selected folder once per IMAP operation. Production rows are
   * constrained by the database and DTO; the INBOX fallback exists solely for pre-migration
   * test doubles/legacy in-memory callers. A malformed persisted value halts rather than
   * silently selecting a different mailbox.
   */
  private selectedMailbox(queue: { mailbox?: unknown }): string {
    try {
      return readCanonicalImapMailbox(queue.mailbox);
    } catch {
      throw new ServiceUnavailableException('Configured IMAP mailbox is invalid');
    }
  }

  /**
   * A numeric queue id alone is not enough isolation for the requested Gmail proof:
   * existing queues default to the shared INBOX. Capture-only must therefore refuse
   * INBOX at the authoritative runtime boundary, including direct/unit callers that
   * bypass the admin form or a preflight command. A dedicated folder may have any
   * provider-specific name, but it cannot be the special shared Inbox.
   */
  private captureMailbox(queue: { id?: number; mailbox?: unknown; useTls?: unknown }): string {
    const mailbox = this.selectedMailbox(queue);
    if (this.inboundCaptureOnlyEnabled) {
      if (queue.id !== this.captureQueueId) {
        throw new ServiceUnavailableException(
          'Capture-only permits IMAP access only for its explicitly selected test queue',
        );
      }
      if (queue.useTls !== true) {
        throw new ServiceUnavailableException(
          'Capture-only requires implicit TLS for the selected IMAP test queue',
        );
      }
      if (isKnownUnsafeCaptureMailbox(mailbox)) {
        throw new ServiceUnavailableException(
          'Capture-only requires an empty dedicated IMAP test folder; Inbox and provider special-use folders are refused',
        );
      }
    }
    return mailbox;
  }

  /**
   * A non-special mailbox name alone is not sufficient proof that a provider has not
   * mapped it to All Mail, Archive, Sent, Trash, or another special-use role. Verify
   * that mapping live before choosing the one-message capture baseline. A missing LIST
   * entry or a no-select folder is equally unsafe: fail closed before reading any body.
   */
  private async assertDedicatedCaptureMailbox(
    client: Pick<ImapFlow, 'list'>,
    mailbox: string,
  ): Promise<void> {
    if (!this.inboundCaptureOnlyEnabled) return;
    let listed: Awaited<ReturnType<ImapFlow['list']>>;
    try {
      listed = await client.list();
    } catch (err) {
      this.logger.warn(`Capture-only mailbox LIST failed (${this.errorKind(err)})`);
      throw new ServiceUnavailableException('Capture-only could not verify the selected IMAP test folder');
    }
    const target = listed.find((entry) => entry.path === mailbox || entry.pathAsListed === mailbox);
    if (!target || target.listed === false) {
      throw new ServiceUnavailableException(
        'Capture-only selected IMAP test folder was not found by the server',
      );
    }
    const flags = target.flags instanceof Set ? target.flags : new Set<string>();
    if (target.specialUse || flags.has('\\Noselect')) {
      throw new ServiceUnavailableException(
        'Capture-only selected an IMAP special-use/non-select folder; create a new empty test folder instead',
      );
    }
  }

  /** The first canary must establish FROM_NOW on an empty dedicated folder, never history. */
  private assertEmptyCaptureMailbox(exists: number | undefined): void {
    if (!this.inboundCaptureOnlyEnabled) return;
    if (exists !== 0) {
      throw new ServiceUnavailableException(
        'Capture-only selected IMAP test folder is not empty; remove test messages or create a new empty folder before baseline',
      );
    }
  }

  /**
   * Arm a queue as capture-only before opening the IMAP connection.  The marker is a
   * permanent, database-backed lifecycle fence: a later normal deployment can never
   * turn residual test mail into tickets.  Queue locking serializes this transition
   * with normal IMAP/PIPE acceptance and with the normal delivery claim transaction.
   *
   * The selected queue/folder must be genuinely fresh.  Even a terminal historical
   * delivery would become stranded behind the permanent marker (for example, a
   * normal QUARANTINED row could no longer be replayed), so do not convert only
   * the active states into a special capture lifecycle.  Refuse every existing
   * inbound-delivery history instead; create a dedicated queue and folder.
   */
  private async armCaptureQueue(queue: ImapAcceptSnapshot, mailbox: string): Promise<boolean> {
    if (!this.inboundCaptureOnlyEnabled) return false;
    // Capture-only keeps the broad retention job disabled, but it must still make one bounded,
    // DB-fenced staging sweep before deciding that a fresh queue is blocked forever. This only
    // reclaims unreferenced expired reservations; it never prunes retained delivery evidence.
    await this.cleanupUncommittedRawStorage();
    const retiredAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<Array<{ id: number; captureRetiredAt: Date | null }>>(Prisma.sql`
        SELECT "id", "captureRetiredAt"
        FROM "EmailQueue"
        WHERE "id" = ${queue.id}
          AND "type" = 'IMAP'
          AND "isEnabled" = true
          AND "syncState" = 'OK'
          AND "mailboxEpoch" = ${queue.mailboxEpoch}
          AND "cursorGeneration" = ${queue.cursorGeneration}
          AND "configGeneration" = ${queue.configGeneration}
          AND "uidValidity" IS NOT DISTINCT FROM ${queue.uidValidity}
          AND "mailbox" = ${mailbox}
        FOR UPDATE
      `);
      const locked = lockedRows[0];
      if (!locked) throw new StaleImapAcceptSnapshotError(queue.id);
      if (locked.captureRetiredAt !== null) return false;

      const existingDeliveries = await tx.inboundDelivery.count({ where: { queueId: queue.id } });
      if (existingDeliveries > 0) {
        throw new ServiceUnavailableException(
          'Capture-only requires a fresh queue with no inbound delivery history; create a new queue and mailbox',
        );
      }

      // A normal acceptance may have fetched MIME, acquired this queue lock, then failed after
      // creating its durable raw-storage reservation. If cleanup is delayed, do not retire the
      // queue underneath those bytes: the reservation must disappear first (or an operator must
      // investigate it). This makes the rollback path fail closed just like the success path.
      const pendingRawStages = await tx.inboundRawMimeStaging.count({ where: { queueId: queue.id } });
      if (pendingRawStages > 0) {
        throw new ServiceUnavailableException(
          'Capture-only cannot arm a queue with pending raw MIME staging; wait for cleanup or use a fresh queue and mailbox',
        );
      }

      const marked = await tx.emailQueue.updateMany({
        where: {
          id: queue.id,
          type: 'IMAP',
          isEnabled: true,
          syncState: 'OK',
          mailboxEpoch: queue.mailboxEpoch,
          cursorGeneration: queue.cursorGeneration,
          configGeneration: queue.configGeneration,
          uidValidity: queue.uidValidity,
          mailbox,
          captureRetiredAt: null,
        },
        data: { captureRetiredAt: retiredAt },
      });
      if (marked.count !== 1) throw new StaleImapAcceptSnapshotError(queue.id);
      await tx.inboundAuditLog.create({
        data: {
          action: 'mail.capture_queue_retired',
          queueId: queue.id,
          reason: 'Capture-only queue armed before IMAP connection',
          metadata: { mailbox, captureRetiredAt: retiredAt.toISOString() } as Prisma.InputJsonValue,
        },
      });
      return true;
    });
  }

  /** Load the exact queue snapshot used to create the capture lifecycle fence. */
  private async armCaptureQueueForConnection(queueId: number): Promise<boolean> {
    const queue = await this.prisma.emailQueue.findUnique({ where: { id: queueId } });
    if (!queue || queue.type !== 'IMAP' || !queue.isEnabled) {
      throw new StaleImapAcceptSnapshotError(queueId);
    }
    const mailbox = this.captureMailbox(queue);
    return this.armCaptureQueue(queue, mailbox);
  }

  /** Remove an unsafe/obsolete authenticated connection from every local registry. */
  private async dropLiveConnection(queueId: number, expected?: ImapFlow): Promise<void> {
    const current = this.connections.get(queueId);
    if (!current || (expected && current !== expected)) return;
    this.connections.delete(queueId);
    this.connectionFingerprints.delete(queueId);
    this.captureReadyQueues.delete(queueId);
    try {
      await current.logout();
    } catch {
      // The registry is already fail-closed; a failed graceful LOGOUT cannot retain it.
    }
    await this.stampQueue(queueId, { lastDisconnectedAt: new Date() });
  }

  private async pollQueue(queueId: number, client: ImapFlow): Promise<void> {
    if (
      !this.inboundAcceptanceEnabled ||
      !this.acceptsQueue(queueId) ||
      this.stopping ||
      this.pollingQueues.has(queueId)
    )
      return;
    this.pollingQueues.add(queueId);
    await this.stampQueue(queueId, { lastPollStartedAt: new Date() });
    try {
      await this.pollQueueOnce(queueId, client);
    } finally {
      this.pollingQueues.delete(queueId);
      await this.stampQueue(queueId, { lastPollCompletedAt: new Date() });
    }
  }

  private async pollQueueOnce(queueId: number, client: ImapFlow): Promise<void> {
    let queue = await this.prisma.emailQueue.findUnique({ where: { id: queueId } });
    if (!queue || !queue.isEnabled || queue.type !== 'IMAP' || !this.acceptsQueue(queueId)) return;
    if (queue.captureRetiredAt != null && !this.inboundCaptureOnlyEnabled) {
      this.logger.warn(`IMAP queue ${queueId}: capture-retired queue is excluded from normal polling`);
      await this.dropLiveConnection(queueId, client);
      return;
    }

    let mailbox: string;
    try {
      mailbox = this.captureMailbox(queue);
      if (this.inboundCaptureOnlyEnabled) {
        // A provider can change special-use mappings after the initial baseline. The
        // per-UID capacity fence below decides whether to fetch a body: it admits an
        // exact transport retry even after the one-message cap is full, so an
        // interrupted cursor update cannot leave the already captured UID stranded.
        // Do not return here merely because the cap is full — that would bypass the
        // exact-retry proof and turn it into a permanent retry loop.
        // `connectQueue()` normally arms this before opening an authenticated IMAP socket.
        // Keep the same durable before-fetch fence for direct/operator test calls that
        // bypass connection setup.
        let captureArmedNow = false;
        if (queue.captureRetiredAt == null) {
          captureArmedNow = await this.armCaptureQueue(queue, mailbox);
          queue = { ...queue, captureRetiredAt: new Date() };
        }
        await this.assertDedicatedCaptureMailbox(client, mailbox);
        if (captureArmedNow) {
          const captureLock = await client.getMailboxLock(mailbox);
          try {
            const { exists } = this.readMailboxState(client);
            this.assertEmptyCaptureMailbox(exists);
          } finally {
            captureLock.release();
          }
        }
      }
    } catch (err) {
      this.logger.error(`IMAP queue ${queueId}: capture mailbox refused (${this.errorKind(err)})`);
      await this.dropLiveConnection(queueId, client);
      await this.stampQueue(queueId, {
        lastConnectionErrorAt: new Date(),
        lastError: 'Capture-only requires a TLS-enabled, canonical dedicated IMAP test folder',
      });
      return;
    }

    if (queue.syncState !== 'OK') {
      if (!this.haltLogged.has(queueId)) {
        this.logger.error(
          `IMAP queue ${queueId} is ${queue.syncState}: ${queue.lastError ?? queue.reconcileCause ?? 'reconcile required'} — ` +
            `operator action is required before polling resumes.`,
        );
        this.haltLogged.add(queueId);
      }
      return;
    }
    this.haltLogged.delete(queueId);

    if (queue.uidValidity === null) {
      // Connect-time bootstrap did not complete (e.g. server had no UIDVALIDITY then).
      await this.bootstrapQueue(queueId, client);
      return;
    }

    // Concurrency is safe WITHOUT a poll lock: each UID is accepted at most once via the
    // unique transport-key claim, and the cursor advances only by monotonic CAS. (A
    // pool-based `pg_advisory_lock` was removed — lock/unlock could land on different
    // pooled sessions and leak the lock forever.)
    {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const { uidValidity } = this.readMailboxState(client);
        if (uidValidity === undefined) {
          this.logger.warn(`IMAP queue ${queueId}: server did not advertise UIDVALIDITY — skipping poll`);
          return;
        }
        if (uidValidity !== queue.uidValidity) {
          // Fail-closed: the server reset its UID space. Do NOT auto-advance (that could
          // skip mail in the new space) — halt and require an explicit operator decision.
          // Gate on the snapshot's cursorGeneration + uidValidity so a STALE poll (whose
          // snapshot predates an operator reconcile that already moved the queue to a new
          // generation) can't clobber the freshly-reconciled OK state with a halt.
          const msg = `UIDVALIDITY changed ${queue.uidValidity} → ${uidValidity}`;
          const halted = await this.haltImapSnapshot(queue, 'UIDVALIDITY_CHANGED', msg);
          if (halted)
            this.logger.error(`IMAP queue ${queueId}: ${msg} — queue halted (NEEDS_RECONCILIATION)`);
          else
            this.logger.warn(`IMAP queue ${queueId}: UIDVALIDITY halt skipped because its snapshot is stale`);
          return;
        }

        // Cursor is a BigInt column (IMAP UIDs are unsigned 32-bit). UID values are well
        // within 2^53, so we compute in Number and store back as BigInt.
        const lastUid = Number(queue.lastSeenUid);
        // Discover new UIDs first (uid-only); sort the resulting set before accepting it.
        const uids: number[] = [];
        const seenUids = new Set<number>();
        for await (const m of client.fetch(`${lastUid + 1}:*`, { uid: true }, { uid: true })) {
          // Compare to the FIXED batch-start cursor, never a moving processed maximum.
          // A server may emit high UIDs before lower ones; accepting the high row must not
          // silently authorise the cursor to jump over a later failure at the lower UID.
          if (typeof m.uid === 'number' && m.uid > lastUid && !seenUids.has(m.uid)) {
            seenUids.add(m.uid);
            uids.push(m.uid);
          }
        }
        // IMAP may return the discovery stream out of order. Fetch/accept in UID order so
        // the cursor remains a contiguous acknowledgement frontier and older messages are
        // never ticketed after newer ones from the same mailbox batch.
        uids.sort((a, b) => a - b);

        let processedMax = lastUid;
        // UIDs are processed in ascending order, so the first failure is the earliest
        // non-durable message and defines the contiguous cursor frontier.
        let lowestFailureUid: number | null = null;
        let acceptedCount = 0;
        for (const uid of uids) {
          try {
            // Do not pull a later message body into memory (or raw-MIME staging) once
            // the attended capture cap is full. A known transport key is the narrow
            // exception: it may be an interrupted retry, and its body hash must still
            // be verified by acceptImapMessage before we acknowledge the UID.
            if (this.inboundCaptureOnlyEnabled && (await this.captureLimitReached(queueId))) {
              const knownTransport = await this.prisma.inboundDelivery.findUnique({
                where: { transportKey: `imap:${queue.id}:${queue.mailboxEpoch}:${uidValidity}:${uid}` },
                select: { id: true },
              });
              if (!knownTransport) {
                throw new ServiceUnavailableException(
                  'Inbound capture-only limit is reached; refusing to fetch another raw message',
                );
              }
            }
            const msg = await client.fetchOne(
              String(uid),
              {
                source: { maxLength: this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024 + 1 },
                envelope: true,
              },
              { uid: true },
            );
            if (!msg || !msg.source) {
              // Vanished (EXPUNGE) between discovery and fetch — nothing to accept.
              processedMax = Math.max(processedMax, uid);
              continue;
            }
            const accepted = await this.acceptImapMessage(
              queue,
              uidValidity,
              uid,
              msg.source,
              (msg as { envelope?: unknown }).envelope,
            );
            if (accepted === 'accepted') acceptedCount += 1;
            processedMax = Math.max(processedMax, uid); // only after durable acceptance
          } catch (err) {
            // Fetch or DB failure → FAIL-CLOSED: stop without advancing past this UID.
            this.logger.error(`IMAP queue ${queueId}: accept failed at uid=${uid} (${this.errorKind(err)})`);
            lowestFailureUid = lowestFailureUid === null ? uid : Math.min(lowestFailureUid, uid);
            break;
          }
        }

        // Safe frontier: because the batch is UID-sorted, a failed UID cannot have an
        // unattempted lower neighbour. The cursor remains immediately before it.
        const cursor =
          lowestFailureUid === null ? processedMax : Math.min(processedMax, lowestFailureUid - 1);

        if (cursor > lastUid) {
          // Monotonic, generation-guarded CAS: advance only if nothing reconciled the
          // queue underneath us (same cursorGeneration + uidValidity, still OK+enabled).
          // A stale poller that finishes after a reconcile writes 0 rows — it can't push
          // a cursor from the old UID space into the new one.
          const cas = await this.prisma.emailQueue.updateMany({
            where: {
              id: queueId,
              type: 'IMAP',
              lastSeenUid: queue.lastSeenUid,
              cursorGeneration: queue.cursorGeneration,
              mailboxEpoch: queue.mailboxEpoch,
              configGeneration: queue.configGeneration,
              mailbox,
              uidValidity: queue.uidValidity,
              syncState: 'OK',
              isEnabled: true,
              ...(this.inboundCaptureOnlyEnabled
                ? { captureRetiredAt: { not: null } }
                : { captureRetiredAt: null }),
            },
            data: { lastSeenUid: BigInt(cursor) },
          });
          if (cas.count === 0) {
            this.logger.warn(`IMAP queue ${queueId}: cursor CAS skipped (queue reconciled mid-poll)`);
          }
        }
        // Operator liveness: stamp the poll time (and accept time when this cycle accepted
        // anything). Advisory only — a separate write, never part of the cursor CAS.
        await this.stampQueue(queueId, {
          lastPollAt: new Date(),
          ...(acceptedCount > 0 ? { lastAcceptedAt: new Date() } : {}),
        });
      } finally {
        lock.release();
      }
    }

    if (this.inboundProcessingEnabled) await this.drainDeliveries();
  }

  /**
   * Raw-MIME retention in bounded batches. QUARANTINED rows are never selected: replay
   * needs their original bytes. Large raw-storage files are deleted only after their terminal
   * delivery is marked pruned; a failed delete leaves the key for the next bounded cleanup.
   */
  private async pruneRawMime(): Promise<void> {
    const days = this.config.TELECOM_HD_INBOUND_RAW_RETENTION_DAYS;
    if (days && days > 0) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000);
      const candidates = await this.prisma.inboundDelivery.findMany({
        where: {
          state: { in: ['PROCESSED', 'SKIPPED'] },
          rawPrunedAt: null,
          createdAt: { lt: cutoff },
        },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true },
      });
      if (candidates.length > 0) {
        const res = await this.prisma.inboundDelivery.updateMany({
          where: { id: { in: candidates.map((candidate) => candidate.id) }, rawPrunedAt: null },
          data: { rawMime: null, rawPrunedAt: new Date() },
        });
        this.logger.log(
          `Inbound retention: pruned inline raw MIME from ${res.count} terminal delivery(ies) older than ${days}d`,
        );
      }
    }
    // A retention policy can later be disabled, but files already marked pruned still need
    // bounded cleanup; do not strand them merely because no new rows are eligible today.
    await this.cleanupPrunedRawStorage();
    // The staging-marker reaper is independent of retention: a process can crash between
    // atomic file rename and ledger INSERT even when raw retention is intentionally disabled.
    await this.cleanupUncommittedRawStorage();
  }

  /** Retry at most 100 orphan-prone terminal file removals per retention cycle. */
  private async cleanupPrunedRawStorage(): Promise<void> {
    if (!this.rawStorage) return;
    const rows = await this.prisma.inboundDelivery.findMany({
      where: { rawPrunedAt: { not: null }, rawStorageKey: { not: null } },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true, rawStorageKey: true },
    });
    for (const row of rows) {
      if (!row.rawStorageKey) continue;
      try {
        await this.rawStorage.remove(row.rawStorageKey);
        await this.prisma.inboundDelivery.updateMany({
          where: { id: row.id, rawStorageKey: row.rawStorageKey },
          data: { rawStorageKey: null },
        });
      } catch (err) {
        this.logger.warn(
          `Inbound raw storage cleanup failed for delivery ${row.id} (${this.errorKind(err)})`,
        );
      }
    }
  }

  /**
   * Recover at most 100 old pending markers and durable staging rows. An ACTIVE row is first
   * committed as REAPING before its file is touched; a final acceptance accepts ACTIVE only and
   * atomically changes it to COMMITTED with the ledger row. This avoids both torn reads and the
   * rollback-after-unlink case where a surviving stage could otherwise be accepted later.
   */
  private async cleanupUncommittedRawStorage(): Promise<void> {
    const rawStorage = this.rawStorage;
    if (!rawStorage) return;
    const now = new Date();
    const olderThan = new Date(now.getTime() - 15 * 60_000);
    let pendingKeys: string[] = [];
    try {
      pendingKeys = await rawStorage.listPending(100, olderThan);
    } catch (err) {
      // Keep going: a crash after reservation commit but before marker creation has no file to
      // list, yet its DB row still needs reaping before it can block a capture arm forever.
      this.logger.warn(`Inbound raw storage marker scan failed (${this.errorKind(err)})`);
    }

    let stageKeys: string[];
    try {
      const stages = await this.prisma.inboundRawMimeStaging.findMany({
        where: {
          OR: [
            { state: 'REAPING' },
            { state: 'COMMITTED' },
            { state: 'ACTIVE', leaseExpiresAt: { lt: now } },
          ],
        },
        orderBy: { leaseExpiresAt: 'asc' },
        take: 100,
        select: { storageKey: true },
      });
      stageKeys = stages.map((stage) => stage.storageKey);
    } catch (err) {
      // Without a database proof we must not remove a file, even if its marker is old.
      this.logger.warn(
        `Inbound raw storage marker cleanup deferred (DB unavailable; ${this.errorKind(err)})`,
      );
      return;
    }

    const candidates = [...new Set([...pendingKeys, ...stageKeys])].slice(0, 100);
    if (candidates.length === 0) return;

    try {
      await this.claimExpiredRawMimeStages(candidates, now);
    } catch (err) {
      this.logger.warn(`Inbound raw storage stage-claim deferred (${this.errorKind(err)})`);
      return;
    }

    for (const storageKey of candidates) {
      const finalized = await this.finalizeRawMimeStage(storageKey, now);
      if (!finalized) continue;
      try {
        // Both a referenced delivery and a safely reaped orphan end with marker cleanup. A
        // marker-removal error is harmless: the next bounded sweep can retry it.
        await rawStorage.commit(storageKey);
      } catch (err) {
        this.logger.warn(
          `Inbound raw storage marker cleanup failed for ${storageKey} (${this.errorKind(err)})`,
        );
      }
    }
  }

  /** Commit an expired ACTIVE reservation as REAPING before any filesystem operation. */
  private async claimExpiredRawMimeStages(keys: string[], now: Date): Promise<void> {
    if (keys.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ storageKey: string }>>(Prisma.sql`
        SELECT "storageKey"
        FROM "InboundRawMimeStaging"
        WHERE "storageKey" IN (${Prisma.join(keys)})
          AND "state" = 'ACTIVE'
          AND "leaseExpiresAt" < ${now}
        FOR UPDATE SKIP LOCKED
      `);
      const claimed = rows
        .map((row) => row.storageKey)
        .filter((storageKey): storageKey is string => typeof storageKey === 'string');
      if (claimed.length === 0) return;
      const transitioned = await tx.inboundRawMimeStaging.updateMany({
        where: {
          storageKey: { in: claimed },
          state: 'ACTIVE',
          leaseExpiresAt: { lt: now },
        },
        data: { state: 'REAPING' },
      });
      if (transitioned.count !== claimed.length) {
        throw new ServiceUnavailableException('Inbound raw MIME stage changed during cleanup');
      }
    });
  }

  /**
   * Finish one already-fenced stage. REAPING is durable before `removeFile()` is called, so a
   * rollback after unlink leaves a REAPING row that acceptance rejects and the next sweep can
   * retry. COMMITTED stages keep their referenced raw file and only shed the marker/reservation.
   */
  private async finalizeRawMimeStage(storageKey: string, _now: Date): Promise<boolean> {
    const rawStorage = this.rawStorage;
    if (!rawStorage) return false;
    let state: 'ACTIVE' | 'COMMITTED' | 'REAPING' | null = null;
    try {
      state = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ state: 'ACTIVE' | 'COMMITTED' | 'REAPING' }>>(Prisma.sql`
          SELECT "state"
          FROM "InboundRawMimeStaging"
          WHERE "storageKey" = ${storageKey}
          FOR UPDATE SKIP LOCKED
        `);
        const stage = rows[0];
        if (!stage) return null;
        if (stage.state === 'ACTIVE') return 'ACTIVE';
        const reference = await tx.inboundDelivery.findFirst({
          where: { rawStorageKey: storageKey },
          select: { id: true },
        });
        if (stage.state === 'COMMITTED') {
          if (!reference) {
            this.logger.error(`Inbound raw MIME COMMITTED stage ${storageKey} has no delivery pointer`);
            return 'ACTIVE';
          }
          const removed = await tx.inboundRawMimeStaging.deleteMany({
            where: { storageKey, state: 'COMMITTED' },
          });
          if (removed.count !== 1) {
            throw new ServiceUnavailableException('Inbound raw MIME stage changed during finalization');
          }
          return 'COMMITTED';
        }
        // REAPING must never have a delivery pointer: acceptance only locks ACTIVE and changes
        // it to COMMITTED in the same transaction as the ledger row. Keep a contradictory row
        // fail-closed rather than deleting evidence under a potentially corrupt pointer.
        if (reference) {
          this.logger.error(
            `Inbound raw MIME REAPING stage ${storageKey} has a delivery pointer; retaining it`,
          );
          return 'ACTIVE';
        }
        return 'REAPING';
      });
    } catch (err) {
      this.logger.warn(`Inbound raw MIME stage lookup deferred for ${storageKey} (${this.errorKind(err)})`);
      return false;
    }

    if (state === 'COMMITTED') return true;
    if (state === 'ACTIVE') return false;
    if (state === 'REAPING') {
      try {
        await rawStorage.removeFile(storageKey);
      } catch (err) {
        this.logger.warn(
          `Inbound raw MIME staged-file cleanup deferred for ${storageKey} (${this.errorKind(err)})`,
        );
        return false;
      }
      try {
        // A second reaper may have completed the idempotent unlink first. Both outcomes are
        // safe because no acceptance can use REAPING; clear the marker in either case.
        await this.prisma.inboundRawMimeStaging.deleteMany({
          where: { storageKey, state: 'REAPING' },
        });
        return true;
      } catch (err) {
        this.logger.warn(
          `Inbound raw MIME stage deletion deferred for ${storageKey} (${this.errorKind(err)})`,
        );
        return false;
      }
    }

    // No lockable stage is usually a live acceptance/reaper. Distinguish it from a genuine
    // legacy orphan without deleting on a mere lock miss.
    try {
      const visible = await this.prisma.inboundRawMimeStaging.findUnique({
        where: { storageKey },
        select: { storageKey: true },
      });
      if (visible) return false;
      const reference = await this.prisma.inboundDelivery.findFirst({
        where: { rawStorageKey: storageKey },
        select: { id: true },
      });
      if (reference) return true;
      await rawStorage.removeFile(storageKey);
      return true;
    } catch (err) {
      this.logger.warn(`Inbound raw MIME orphan cleanup deferred for ${storageKey} (${this.errorKind(err)})`);
      return false;
    }
  }

  /** Best-effort advisory write of a queue's liveness timestamps. Never throws (a failed
   *  liveness stamp must not break a poll) and touches only the given columns. */
  private async stampQueue(
    queueId: number,
    data: {
      lastConnectionAttemptAt?: Date;
      lastConnectedAt?: Date;
      lastDisconnectedAt?: Date;
      lastConnectionErrorAt?: Date;
      lastPollStartedAt?: Date;
      lastPollAt?: Date;
      lastPollCompletedAt?: Date;
      lastAcceptedAt?: Date;
      lastError?: string | null;
    },
  ): Promise<void> {
    try {
      await this.prisma.emailQueue.updateMany({ where: { id: queueId }, data });
    } catch (err) {
      this.logger.warn(`IMAP queue ${queueId}: liveness stamp failed (${this.errorKind(err)})`);
    }
  }

  /**
   * Durably record one IMAP message in the ledger under its unique transport key.
   * Idempotent: a duplicate key (re-poll / concurrent poller) is a no-op. The message
   * is NOT parsed here — a malformed MIME is still ACCEPTED (never lost) and is
   * quarantined later by the drain if it cannot be processed. In explicit
   * capture-only mode, complete messages are CAPTURED instead and never enter drain.
   */
  private async acceptImapMessage(
    snapshot: ImapAcceptSnapshot,
    uidValidity: bigint,
    uid: number,
    source: Buffer,
    envelope?: unknown,
  ): Promise<'accepted' | 'duplicate'> {
    if (!this.inboundAcceptanceEnabled) {
      throw new ServiceUnavailableException('Inbound acceptance is temporarily disabled');
    }
    if (!this.acceptsQueue(snapshot.id)) {
      throw new ServiceUnavailableException('This IMAP queue is outside the active inbound scope');
    }
    if (
      snapshot.type !== 'IMAP' ||
      !snapshot.isEnabled ||
      snapshot.syncState !== 'OK' ||
      snapshot.uidValidity === null ||
      snapshot.uidValidity !== uidValidity ||
      (this.inboundCaptureOnlyEnabled ? snapshot.captureRetiredAt == null : snapshot.captureRetiredAt != null)
    ) {
      throw new StaleImapAcceptSnapshotError(snapshot.id);
    }

    const mailbox = this.captureMailbox(snapshot);
    const transportKey = `imap:${snapshot.id}:${snapshot.mailboxEpoch}:${uidValidity}:${uid}`;
    const contentHash = createHash('sha256').update(source).digest('hex');
    // Capture-only deliberately does not invoke mailparser or any routing/ticket code.
    // IMAP's server-supplied ENVELOPE is a bounded metadata preview for the operator UI;
    // it does not create a logical Message-ID claim or change future promotion semantics.
    const captureMetadata = this.inboundCaptureOnlyEnabled ? this.captureImapEnvelopeMetadata(envelope) : {};
    // The IMAP fetch caps the body at MAX_SIZE+1 bytes; a source at/over the ceiling was
    // TRUNCATED — its retained raw MIME is incomplete, so quarantine it at acceptance.
    // Capture-only must never describe incomplete bytes as a successful capture.
    const truncated = source.length > this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024;
    // A large body first gets a short, durable queue-bound reservation. That reservation is
    // committed before the filesystem write, so capture arming either wins before any bytes
    // are staged or observes the reservation and refuses to retire this queue until cleanup.
    // Inline bytes have no external persistence and remain protected by the final row lock.
    const raw = await this.persistRawMime(source, snapshot.id, this.inboundCaptureOnlyEnabled);
    const cleanupStagedRaw = async (): Promise<void> => this.discardRawStage(raw.rawStorageKey);
    let outcome: 'accepted' | 'duplicate' | 'collision';
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // This row lock is the acceptance fence.  If identity/reconcile won first, the
        // conditional SELECT finds no row and no ledger delivery is inserted.  If acceptance
        // obtains the lock first, it is durably accepted before the new boundary — which is
        // safe; the concurrent identity/reconcile update waits and subsequently bumps epoch.
        const current = await tx.$queryRaw<
          Array<{
            id: number;
            emailAddress: string;
            departmentId: number | null;
            sendAutoresponder: boolean;
            configGeneration: number;
            mailbox?: string;
          }>
        >(Prisma.sql`
        SELECT "id", "emailAddress", "departmentId", "sendAutoresponder", "configGeneration", "mailbox"
        FROM "EmailQueue"
        WHERE "id" = ${snapshot.id}
          AND "isEnabled" = true
          AND "type" = 'IMAP'
          AND "syncState" = 'OK'
          AND "mailboxEpoch" = ${snapshot.mailboxEpoch}
          AND "cursorGeneration" = ${snapshot.cursorGeneration}
          AND "configGeneration" = ${snapshot.configGeneration}
          AND "uidValidity" = ${snapshot.uidValidity}
          AND "mailbox" = ${mailbox}
          ${
            this.inboundCaptureOnlyEnabled
              ? Prisma.sql`AND "captureRetiredAt" IS NOT NULL`
              : Prisma.sql`AND "captureRetiredAt" IS NULL`
          }
        FOR UPDATE
        `);
        const lockedQueue = current[0];
        if (
          !lockedQueue ||
          lockedQueue.emailAddress !== snapshot.emailAddress ||
          lockedQueue.departmentId !== snapshot.departmentId ||
          lockedQueue.sendAutoresponder !== snapshot.sendAutoresponder ||
          lockedQueue.configGeneration !== snapshot.configGeneration ||
          this.selectedMailbox(lockedQueue) !== mailbox
        ) {
          throw new StaleImapAcceptSnapshotError(snapshot.id);
        }
        // An exact transport retry is a no-op even after the capture test has reached
        // its one-message limit. Check it before capacity so an IMAP reconnect cannot
        // turn a safely captured UID into a permanent retry storm. A non-exact existing
        // transport key continues through the collision path below (never hide it behind
        // a capacity response).
        const existingTransport = await tx.inboundDelivery.findUnique({
          where: { transportKey },
          select: { queueId: true, mailboxEpoch: true, uidValidity: true, uid: true, contentHash: true },
        });
        const existingIsExactRetry =
          existingTransport?.queueId === snapshot.id &&
          existingTransport.mailboxEpoch === snapshot.mailboxEpoch &&
          existingTransport.uidValidity === uidValidity &&
          existingTransport.uid === BigInt(uid) &&
          existingTransport.contentHash === contentHash;
        if (existingIsExactRetry) return 'duplicate';
        if (!existingTransport) {
          await this.assertCaptureCapacity(tx, snapshot.id);
        }
        // Freeze every enabled recipient queue (including its priority and customer-mail
        // policy) in the same transaction as the ledger row.  A later drain must not make
        // a CC-copy's owner depend on which poller happened to claim first or on a subsequent
        // operator edit to the queue form.
        const routingSnapshot = await this.captureRoutingSnapshot(tx, lockedQueue);
        await this.lockRawStageForAcceptance(tx, raw.rawStorageKey);

        // `createMany(skipDuplicates)` maps to INSERT .. ON CONFLICT DO NOTHING.  It avoids
        // poisoning a PostgreSQL transaction with P2002 before we can inspect the conflicting
        // row.  At accept time messageId is NULL, so the only expected unique conflict is the
        // canonical transport key; a missing/different prior row is treated fail-closed below.
        const created = await tx.inboundDelivery.createMany({
          data: {
            transport: 'IMAP',
            queueId: snapshot.id,
            // Values come from the row locked by the acceptance fence, never a
            // pre-fetch snapshot which a concurrent queue edit could have made stale.
            departmentId: lockedQueue.departmentId,
            sendAutoresponder: lockedQueue.sendAutoresponder,
            routedQueueId: lockedQueue.id,
            routedDepartmentId: lockedQueue.departmentId,
            // Normal ingress has no safely resolved business owner until the MIME is parsed
            // (a parser rule or thread can target another department). A captured/truncated
            // row never enters normal ticket processing, so its receiving department is safe
            // for the attended operator view.
            ...(truncated || this.inboundCaptureOnlyEnabled
              ? lockedQueue.departmentId != null
                ? {
                    effectiveOwnerKind: 'RECEIVING' as const,
                    effectiveOwnerDepartmentId: lockedQueue.departmentId,
                  }
                : { effectiveOwnerKind: 'UNRESOLVED' as const }
              : { effectiveOwnerKind: 'UNRESOLVED' as const }),
            routingSnapshot: routingSnapshot as unknown as Prisma.InputJsonValue,
            // IMAP does not always expose the original SMTP envelope recipient in MIME.  The
            // configured queue address is the trusted receiving-mailbox fallback used by the
            // deterministic routing policy (not a header-derived guess).
            envelopeTo: lockedQueue.emailAddress,
            ...captureMetadata,
            transportKey,
            mailboxEpoch: snapshot.mailboxEpoch,
            uidValidity,
            uid: BigInt(uid),
            contentHash,
            rawMime: raw.rawMime,
            rawStorageKey: raw.rawStorageKey,
            sizeBytes: source.length,
            truncated,
            state: truncated ? 'QUARANTINED' : this.inboundCaptureOnlyEnabled ? 'CAPTURED' : 'ACCEPTED',
            ...(truncated
              ? {
                  lastError:
                    'oversized: the fetched raw MIME is truncated at the size ceiling — re-fetch the original message to replay',
                }
              : {}),
          },
          skipDuplicates: true,
        });
        if (created.count === 1) {
          await this.markRawStageCommitted(tx, raw.rawStorageKey);
          if (this.inboundCaptureOnlyEnabled) {
            // One capture row is the entire attended experiment.  Disable the
            // marker queue in the same transaction as the ledger insert so a
            // later restart, UIDVALIDITY reset, or extra message cannot make the
            // same folder serve as normal ingress.
            const retired = await tx.emailQueue.updateMany({
              where: {
                id: snapshot.id,
                type: 'IMAP',
                isEnabled: true,
                syncState: 'OK',
                mailboxEpoch: snapshot.mailboxEpoch,
                cursorGeneration: snapshot.cursorGeneration,
                configGeneration: snapshot.configGeneration,
                mailbox,
                uidValidity: snapshot.uidValidity,
                captureRetiredAt: { not: null },
              },
              data: {
                isEnabled: false,
                lastError:
                  'Capture-only queue retired after its one retained message; create a new queue and mailbox for future inbound tests',
              },
            });
            if (retired.count !== 1) throw new StaleImapAcceptSnapshotError(snapshot.id);
          }
          return 'accepted';
        }

        const prior = await tx.inboundDelivery.findUnique({
          where: { transportKey },
          select: { queueId: true, mailboxEpoch: true, uidValidity: true, uid: true, contentHash: true },
        });
        const isExactRetry =
          prior?.queueId === snapshot.id &&
          prior.mailboxEpoch === snapshot.mailboxEpoch &&
          prior.uidValidity === uidValidity &&
          prior.uid === BigInt(uid) &&
          prior.contentHash === contentHash;
        if (isExactRetry) return 'duplicate';

        // A different body for the same epoch+UID means a corrupt server/transport identity;
        // never consume it as a duplicate.  Halt the exact snapshot and write durable audit in
        // the same transaction.  If the conditional halt loses its CAS, a newer epoch already
        // owns the queue and this stale poller must simply fail closed.
        const msg =
          `IMAP transport collision for ${transportKey}: existing delivery identity/content differs; ` +
          `queue halted for explicit reconcile`;
        const halted = await tx.emailQueue.updateMany({
          where: {
            id: snapshot.id,
            type: 'IMAP',
            isEnabled: true,
            syncState: 'OK',
            mailboxEpoch: snapshot.mailboxEpoch,
            cursorGeneration: snapshot.cursorGeneration,
            configGeneration: snapshot.configGeneration,
            mailbox,
            uidValidity: snapshot.uidValidity,
            ...(this.inboundCaptureOnlyEnabled
              ? { captureRetiredAt: { not: null } }
              : { captureRetiredAt: null }),
          },
          data: {
            syncState: 'NEEDS_RECONCILIATION',
            reconcileCause: 'TRANSPORT_COLLISION',
            reconcileRequestedAt: null,
            lastError: msg,
          },
        });
        if (halted.count !== 1) throw new StaleImapAcceptSnapshotError(snapshot.id);
        await tx.inboundAuditLog.create({
          data: {
            action: 'mail.transport_collision',
            queueId: snapshot.id,
            reason: 'IMAP transport identity reused with different content',
            metadata: {
              transportKey,
              mailboxEpoch: snapshot.mailboxEpoch,
              uidValidity: uidValidity.toString(),
              uid,
              attemptedContentHash: contentHash,
              prior: prior
                ? {
                    queueId: prior.queueId,
                    mailboxEpoch: prior.mailboxEpoch,
                    uidValidity: prior.uidValidity?.toString() ?? null,
                    uid: prior.uid?.toString() ?? null,
                    contentHash: prior.contentHash,
                  }
                : null,
            } as Prisma.InputJsonValue,
          },
        });
        // Return normally so the halt and audit COMMIT. Throwing inside the Prisma
        // transaction would roll those safety records back and leave the queue polling.
        return 'collision';
      });
    } catch (err) {
      await cleanupStagedRaw();
      throw err;
    }

    if (outcome === 'accepted') {
      await this.finalizeAcceptedRawStage(raw.rawStorageKey);
      return outcome;
    }

    // We created a fresh staged file for a delivery which was already present or was a
    // transport collision; it must not be retained as an unrelated raw-MIME object.
    await cleanupStagedRaw();
    if (outcome === 'collision') throw new ImapTransportCollisionError(snapshot.id, transportKey);
    return outcome;
  }

  /**
   * Extract only a small, display-safe preview from IMAP's already-requested ENVELOPE.
   * This is intentionally not MIME parsing: it never touches message body/attachments,
   * does not validate or claim a Message-ID, and is used only on capture-only terminal
   * CAPTURED/QUARANTINED rows so an operator can identify the attended canary.
   */
  private captureImapEnvelopeMetadata(envelope: unknown): {
    observedMessageId?: string;
    envelopeFrom?: string;
    subject?: string;
  } {
    if (!envelope || typeof envelope !== 'object') return {};
    const value = envelope as { subject?: unknown; messageId?: unknown; from?: unknown };
    const metadata: { observedMessageId?: string; envelopeFrom?: string; subject?: string } = {};
    if (typeof value.subject === 'string') {
      const subject = value.subject
        .slice(0, MAX_SUBJECT_CHARS)
        .replace(/[\r\n]/g, ' ')
        .replaceAll('\0', ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (subject) metadata.subject = subject;
    }
    const observedMessageId = this.normalizeMessageId(value.messageId);
    if (observedMessageId) metadata.observedMessageId = observedMessageId;
    if (Array.isArray(value.from)) {
      for (const entry of value.from) {
        if (!entry || typeof entry !== 'object') continue;
        const rawAddress = (entry as { address?: unknown }).address;
        if (typeof rawAddress !== 'string') continue;
        const address = normalizeEmail(rawAddress);
        if (this.isPlausibleEmail(address)) {
          metadata.envelopeFrom = address;
          break;
        }
      }
    }
    return metadata;
  }

  /**
   * Read the enabled queues after the receiving queue has been locked by the acceptance
   * fence. The returned JSON is deliberately small, deterministic and self-contained: it is
   * the only queue configuration a later ledger drain is allowed to use for recipient routing.
   */
  private async captureRoutingSnapshot(
    tx: Prisma.TransactionClient,
    receivingQueue: {
      id: number;
      emailAddress: string;
      departmentId: number | null;
      sendAutoresponder: boolean;
    },
  ): Promise<RoutingSnapshotEntry[]> {
    const queues = await tx.emailQueue.findMany({
      where: {
        isEnabled: true,
        ...(this.inboundCaptureOnlyEnabled
          ? { captureRetiredAt: { not: null } }
          : { captureRetiredAt: null }),
      },
      select: {
        id: true,
        emailAddress: true,
        departmentId: true,
        routingPriority: true,
        sendAutoresponder: true,
      },
    });
    const snapshot = queues
      .filter((queue) => normalizeEmail(queue.emailAddress) !== '')
      .map((queue) => ({
        id: queue.id,
        emailAddress: queue.emailAddress,
        departmentId: queue.departmentId,
        routingPriority: queue.routingPriority,
        sendAutoresponder: queue.sendAutoresponder,
      }))
      .sort((a, b) => a.routingPriority - b.routingPriority || a.id - b.id);

    // The receiving row is SELECT ... FOR UPDATE and enabled, therefore it must be present in
    // the same transaction's enabled-queue view. Treat an impossible/inconsistent view as a
    // stale acceptance fence rather than silently writing a partial route snapshot.
    const receiving = snapshot.find((queue) => queue.id === receivingQueue.id);
    if (
      !receiving ||
      receiving.emailAddress !== receivingQueue.emailAddress ||
      receiving.departmentId !== receivingQueue.departmentId ||
      receiving.sendAutoresponder !== receivingQueue.sendAutoresponder
    ) {
      throw new StaleImapAcceptSnapshotError(receivingQueue.id);
    }
    return snapshot;
  }

  /** Set a typed UIDVALIDITY halt plus its durable audit atomically. */
  private async haltImapSnapshot(
    snapshot: ImapAcceptSnapshot,
    cause: 'UIDVALIDITY_CHANGED',
    message: string,
  ): Promise<boolean> {
    const mailbox = this.captureMailbox(snapshot);
    return this.prisma.$transaction(async (tx) => {
      const halt = await tx.emailQueue.updateMany({
        where: {
          id: snapshot.id,
          type: 'IMAP',
          isEnabled: true,
          syncState: 'OK',
          mailboxEpoch: snapshot.mailboxEpoch,
          cursorGeneration: snapshot.cursorGeneration,
          configGeneration: snapshot.configGeneration,
          mailbox,
          uidValidity: snapshot.uidValidity,
          ...(this.inboundCaptureOnlyEnabled
            ? { captureRetiredAt: { not: null } }
            : { captureRetiredAt: null }),
        },
        data: {
          syncState: 'NEEDS_RECONCILIATION',
          reconcileCause: cause,
          reconcileRequestedAt: null,
          lastError: message,
        },
      });
      if (halt.count !== 1) return false;
      await tx.inboundAuditLog.create({
        data: {
          action: 'mail.reconcile_failed',
          queueId: snapshot.id,
          reason: message,
          metadata: {
            cause,
            mailboxEpoch: snapshot.mailboxEpoch,
            cursorGeneration: snapshot.cursorGeneration,
            mailbox,
            uidValidity: snapshot.uidValidity?.toString() ?? null,
          } as Prisma.InputJsonValue,
        },
      });
      return true;
    });
  }

  // ─────────────────── PIPE ingress ───────────────────

  /**
   * Public entry for the MTA/PIPE webhook. Records the message in the ledger (idempotent
   * by a trusted caller-supplied delivery id) and normally processes it inline so the
   * caller sees the ticket immediately; a transient failure leaves a RETRY the drain
   * picks up. Capture-only is deliberately IMAP-only and rejects this path before it
   * persists raw MIME or parses/routes/creates any ticket work.
   */
  async ingestRawMessage(
    source: Buffer | string,
    departmentId: number | undefined,
    externalId?: string,
    queueId?: number,
  ): Promise<void> {
    if (!this.inboundAcceptanceEnabled) {
      throw new ServiceUnavailableException('Inbound acceptance is temporarily disabled');
    }
    if (this.inboundCaptureOnlyEnabled) {
      throw new ServiceUnavailableException('PIPE ingress is disabled during IMAP capture-only mode');
    }
    const buf = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    if (buf.length > this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024) {
      throw new PayloadTooLargeException('Inbound message exceeds the configured size limit');
    }

    // PIPE has no safe default queue: accepting a request against an unknown/disabled/IMAP
    // queue would turn routing into a silent fallback. Snapshot the active PIPE queue's
    // department at acceptance so later configuration edits cannot reroute this delivery.
    if (queueId == null) throw new BadRequestException('x-inbound-queue-id is required for PIPE ingress');
    if (!this.acceptsQueue(queueId)) {
      throw new ServiceUnavailableException('This PIPE queue is outside the active inbound scope');
    }
    const normalizedExternalId = normalizePipeDeliveryId(externalId);
    const q = await this.prisma.emailQueue.findUnique({
      where: { id: queueId },
      select: {
        id: true,
        emailAddress: true,
        departmentId: true,
        sendAutoresponder: true,
        type: true,
        isEnabled: true,
        captureRetiredAt: true,
      },
    });
    if (!q) throw new BadRequestException(`Unknown inbound queue id ${queueId}`);
    if (!q.isEnabled) throw new BadRequestException(`Inbound PIPE queue ${queueId} is disabled`);
    if (q.type !== 'PIPE') {
      throw new BadRequestException(`Inbound queue ${queueId} must have type PIPE (got ${q.type})`);
    }
    if (q.captureRetiredAt !== null) {
      throw new ConflictException(
        `Inbound PIPE queue ${queueId} was permanently retired after capture-only use; create a new queue instead`,
      );
    }
    const boundQueueId = q.id;
    // The webhook never trusts a caller-provided department. An internal caller may only
    // supply the same snapshot; otherwise fail closed rather than misroute a ticket.
    if (departmentId !== undefined && departmentId !== q.departmentId) {
      throw new BadRequestException('PIPE department must match the bound queue');
    }
    const contentHash = createHash('sha256').update(buf).digest('hex');
    // Index a fixed-width SHA-256 of the normalized MTA id rather than an arbitrary
    // header value. Keep the original normalized id for diagnostics/audit.
    const deliveryIdHash = createHash('sha256').update(normalizedExternalId).digest('hex');
    const transportKey = `pipe:${boundQueueId}:id-sha256:${deliveryIdHash}`;

    // Reserve large raw MIME under the normal queue lifecycle fence before writing it. A
    // capture transition sees this durable queue-bound reservation and fails closed until the
    // file cleanup completes, even if the final PIPE acceptance later rolls back.
    const raw = await this.persistRawMime(buf, boundQueueId, false);
    const cleanupStagedRaw = async (): Promise<void> => this.discardRawStage(raw.rawStorageKey);
    let accepted: { id: number; departmentId: number | null; duplicate: boolean };
    try {
      accepted = await this.prisma.$transaction(async (tx) => {
        // Re-check and lock the queue in the same transaction as the ledger insert. A
        // concurrent disable or IMAP/PIPE type switch must not admit a late PIPE delivery.
        const locked = await tx.$queryRaw<
          Array<{
            id: number;
            emailAddress: string;
            departmentId: number | null;
            sendAutoresponder: boolean;
          }>
        >(
          Prisma.sql`
            SELECT "id", "emailAddress", "departmentId", "sendAutoresponder"
            FROM "EmailQueue"
            WHERE "id" = ${boundQueueId}
              AND "type" = 'PIPE'
              AND "isEnabled" = true
              AND "captureRetiredAt" IS NULL
            FOR UPDATE
          `,
        );
        const queue = locked[0];
        if (!queue) {
          throw new ConflictException(
            'Inbound PIPE queue changed while delivery was accepted; retry after reload',
          );
        }
        if (departmentId !== undefined && departmentId !== queue.departmentId) {
          throw new ConflictException('Inbound PIPE queue department changed while delivery was accepted');
        }
        // Preserve idempotency before accepting a new normal PIPE delivery. The selected
        // queue row is locked above, so concurrent MTA callbacks remain deterministic.
        const existingTransport = await tx.inboundDelivery.findUnique({
          where: { transportKey },
          select: { id: true, contentHash: true },
        });
        if (existingTransport?.contentHash === contentHash) {
          return { id: existingTransport.id, departmentId: queue.departmentId, duplicate: true };
        }
        // PIPE uses the exact same immutable recipient/priorities snapshot as IMAP. Without
        // this, two MTA copies bearing the same Message-ID could assign ownership to whichever
        // PIPE drain happened to create the logical claim first.
        const routingSnapshot = await this.captureRoutingSnapshot(tx, queue);
        await this.lockRawStageForAcceptance(tx, raw.rawStorageKey);
        const created = await tx.inboundDelivery.create({
          data: {
            transport: 'PIPE',
            queueId: queue.id,
            departmentId: queue.departmentId,
            sendAutoresponder: queue.sendAutoresponder,
            routedQueueId: queue.id,
            routedDepartmentId: queue.departmentId,
            // PIPE is always normal ingress: do not grant a receiving-queue operator access
            // until the parser/thread route has produced the effective ticket owner.
            effectiveOwnerKind: 'UNRESOLVED',
            effectiveOwnerDepartmentId: null,
            routingSnapshot: routingSnapshot as unknown as Prisma.InputJsonValue,
            transportKey,
            externalId: normalizedExternalId,
            contentHash,
            // The MTA-selected queue is the trusted envelope fallback; do not route from a
            // caller-controlled MIME To header.
            envelopeTo: queue.emailAddress,
            rawMime: raw.rawMime,
            rawStorageKey: raw.rawStorageKey,
            sizeBytes: buf.length,
            state: 'ACCEPTED',
          },
          select: { id: true },
        });
        await this.markRawStageCommitted(tx, raw.rawStorageKey);
        return { id: created.id, departmentId: queue.departmentId, duplicate: false };
      });
    } catch (err) {
      await cleanupStagedRaw();
      if (this.isUniqueViolation(err)) {
        // A reused delivery id already exists. If the content matches, this is an
        // idempotent re-delivery — no-op. If it DIFFERS, the caller reused an
        // `x-inbound-delivery-id` for a DIFFERENT message: reject 409 so the second
        // message is not silently lost (rather than dropping it).
        const prior = await this.prisma.inboundDelivery.findUnique({
          where: { transportKey },
          select: { id: true, contentHash: true },
        });
        if (!prior) {
          // A P2002 with no matching transport row means the database rejected a different
          // unique constraint or a concurrent delete occurred. Never treat that as a retry.
          await this.recordInboundCollision({
            queueId: boundQueueId,
            contentHash,
            reason: 'PIPE delivery-id collision could not be verified against a prior transport row',
          });
          throw new ConflictException('Inbound delivery collision could not be verified safely');
        }
        if (prior.contentHash !== contentHash) {
          await this.recordInboundCollision({
            queueId: boundQueueId,
            deliveryId: prior.id,
            contentHash,
            priorContentHash: prior.contentHash,
            reason: 'PIPE delivery id was reused with different message content',
          });
          throw new ConflictException(
            `Inbound delivery id already used for a different message (contentHash mismatch)`,
          );
        }
        this.logger.log(`PIPE: duplicate delivery (${transportKey}) — already accepted`);
        return; // idempotent re-delivery
      }
      throw err;
    }
    if (accepted.duplicate) {
      await cleanupStagedRaw();
      this.logger.log(`PIPE: duplicate delivery (${transportKey}) — already accepted`);
      return;
    }
    await this.finalizeAcceptedRawStage(raw.rawStorageKey);
    // CAPTURED rows are deliberately terminal from the drain's point of view. Do not
    // invoke the inline PIPE path either: it is a direct ticket/outbox execution route.
    if (this.inboundProcessingEnabled) {
      await this.processDelivery(accepted.id, accepted.departmentId ?? undefined);
    }
  }

  // ─────────────────── drain (process ledger) ───────────────────

  /**
   * Normal delivery must never select a capture-retired queue.  The sole
   * exception is the exact, reviewed promotion canary, which deliberately
   * drains one `capturePromotedAt` row from that retired queue.
   */
  private normalDeliveryLifecycleFence(
    canary: { queueId: number; deliveryId: number } | null,
  ): Prisma.InboundDeliveryWhereInput {
    return canary
      ? { queue: { is: { captureRetiredAt: { not: null } } } }
      : { NOT: { queue: { is: { captureRetiredAt: { not: null } } } } };
  }

  /**
   * Acquire the same queue row lock used by capture arming before changing a
   * delivery to PROCESSING.  A missing queue is allowed only for an old normal
   * ledger row; capture-retired queues cannot be deleted by the migration guard,
   * so they cannot fall through this legacy compatibility case.
   */
  private async lockDeliveryQueueForNormalProcessing(
    tx: Prisma.TransactionClient,
    deliveryId: number,
    canary: { queueId: number; deliveryId: number } | null,
  ): Promise<boolean> {
    const delivery = await tx.inboundDelivery.findUnique({
      where: { id: deliveryId },
      select: { queueId: true },
    });
    if (!delivery) return false;
    if (delivery.queueId === null) return canary === null;
    if (canary && delivery.queueId !== canary.queueId) return false;

    const queues = await tx.$queryRaw<Array<{ id: number; captureRetiredAt: Date | null }>>(Prisma.sql`
      SELECT "id", "captureRetiredAt"
      FROM "EmailQueue"
      WHERE "id" = ${delivery.queueId}
      FOR UPDATE
    `);
    const queue = queues[0];
    if (!queue) return false;
    return canary ? queue.captureRetiredAt !== null : queue.captureRetiredAt === null;
  }

  /**
   * Process due deliveries in id order: fresh `ACCEPTED`/`RETRY` work, plus any
   * `PROCESSING` whose lease has expired (a worker crashed mid-processing) — so a
   * delivery can never be stranded in `PROCESSING` forever.
   */
  drainDeliveries(): Promise<void> {
    if (!this.inboundProcessingEnabled) return Promise.resolve();
    if (this.stopping) return this.drainInFlight ?? Promise.resolve();
    if (this.drainInFlight) return this.drainInFlight;

    const cycle = this.runDrainDeliveries().finally(() => {
      if (this.drainInFlight === cycle) this.drainInFlight = null;
    });
    this.drainInFlight = cycle;
    return cycle;
  }

  private async runDrainDeliveries(): Promise<void> {
    if (!this.inboundProcessingEnabled) return;
    const now = new Date();
    let due: Array<{ id: number; departmentId: number | null }>;
    try {
      const canary = this.normalDeliveryCanary;
      if (this.normalDeliveryCanaryConfigured && !canary) {
        this.logger.error(
          'Inbound normal-delivery canary configuration is incomplete; drain remains fail-closed',
        );
        return;
      }
      due = await this.prisma.inboundDelivery.findMany({
        where: {
          ...this.normalDeliveryLifecycleFence(canary),
          ...(canary
            ? {
                id: canary.deliveryId,
                queueId: canary.queueId,
                capturePromotedAt: { not: null },
              }
            : {}),
          OR: [
            {
              state: { in: ['ACCEPTED', 'RETRY'] },
              OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
            },
            // Reclaim expired leases (stale PROCESSING from a crashed worker).
            { state: 'PROCESSING', leaseExpiresAt: { lt: now } },
          ],
        },
        orderBy: { id: 'asc' },
        take: 50,
        select: { id: true, departmentId: true },
      });
    } catch (err) {
      this.logger.error(`Inbound drain query failed (${this.errorKind(err)})`);
      return;
    }
    for (const d of due) {
      // Route by the department snapshotted at acceptance, not the queue's current one.
      await this.processDelivery(d.id, d.departmentId ?? undefined);
    }
  }

  /**
   * Process a single ledger delivery. Claims it with a LEASE (CAS: ACCEPTED/RETRY, or a
   * PROCESSING whose lease has expired → PROCESSING + our lease), runs the routing
   * pipeline, then transitions to PROCESSED/SKIPPED — but every terminal/retry write is
   * itself lease-gated (`leaseOwner = us`), so if our lease expired and another worker
   * took over mid-processing we drop our result instead of clobbering theirs. Any error
   * → RETRY (backoff) or, once attempts are exhausted, QUARANTINED — raw MIME is always
   * retained, so a message is never lost, discarded, or stranded in PROCESSING.
   */
  private async processDelivery(deliveryId: number, departmentId: number | undefined): Promise<void> {
    if (!this.inboundProcessingEnabled) return;
    // In-process guard: never handle the same delivery twice concurrently in this process
    // (closes the "slow flow, lease expired, drain reclaims it" duplicate window).
    if (this.inFlight.has(deliveryId)) return;
    this.inFlight.add(deliveryId);
    try {
      await this.processDeliveryClaimed(deliveryId, departmentId);
    } finally {
      this.inFlight.delete(deliveryId);
    }
  }

  private async processDeliveryClaimed(deliveryId: number, departmentId: number | undefined): Promise<void> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + InboundMailService.LEASE_MS);
    // A FRESH per-claim token (not the process id) so the settle fence distinguishes THIS
    // claim from a later reclaim: if our lease expired and another claim took over, our
    // terminal write matches 0 rows instead of clobbering theirs.
    const leaseToken = randomUUID();
    const canary = this.normalDeliveryCanary;
    if (this.normalDeliveryCanaryConfigured && !canary) {
      this.logger.error(
        'Inbound normal-delivery canary configuration is incomplete; claim remains fail-closed',
      );
      return;
    }
    if (canary && deliveryId !== canary.deliveryId) return;
    const claim = await this.prisma.$transaction(async (tx) => {
      // ArmCaptureQueue locks this same EmailQueue row before checking active
      // deliveries.  Taking the lock before the claim CAS closes the last race:
      // a normal worker cannot turn an ACCEPTED row into ticket work after the
      // queue has successfully become capture-retired.
      if (!(await this.lockDeliveryQueueForNormalProcessing(tx, deliveryId, canary))) {
        return { count: 0 };
      }
      return tx.inboundDelivery.updateMany({
        where: {
          id: deliveryId,
          ...this.normalDeliveryLifecycleFence(canary),
          ...(canary ? { queueId: canary.queueId, capturePromotedAt: { not: null } } : {}),
          OR: [
            { state: 'ACCEPTED' },
            // A RETRY is only claimable once its backoff has elapsed. Enforce the schedule
            // in the CLAIM CAS itself (not only in the drain's pre-select) so any caller —
            // an inline ingest, a future direct call, or a racing worker — can never claim a
            // not-yet-due RETRY and burn an attempt early.
            { state: 'RETRY', OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
            { state: 'PROCESSING', leaseExpiresAt: { lt: now } }, // reclaim expired lease
          ],
        },
        // Increment `attempts` in the CLAIM itself, NOT only in the lease-fenced settle: a
        // delivery whose processing consistently outlives the lease would otherwise have every
        // settle rejected (wrong lease owner) and its attempt-count never advance → retried
        // forever, never quarantined. Counting per claim guarantees the budget is exhausted.
        data: {
          state: 'PROCESSING',
          leaseOwner: leaseToken,
          leaseExpiresAt: leaseUntil,
          attempts: { increment: 1 },
        },
      });
    });
    if (claim.count === 0) return; // another worker holds a live lease, or already terminal

    const delivery = await this.prisma.inboundDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) return;

    // All terminal/retry writes are CAS-gated on OUR lease token so a claim that reclaimed
    // an expired lease can't be overwritten by the original stalled flow. A 0-row settle
    // means our lease was stolen (processing outlived it and another worker reclaimed) —
    // surface it instead of silently discarding the result; the winner will settle it.
    const settle = async (data: Record<string, unknown>) => {
      const res = await this.prisma.inboundDelivery.updateMany({
        where: { id: deliveryId, leaseOwner: leaseToken, state: 'PROCESSING' },
        data,
      });
      if (res.count === 0) {
        this.logger.warn(
          `Inbound delivery ${deliveryId}: settle no-op — lease lost mid-processing ` +
            `(reclaimed by another worker); result dropped, the current owner will settle it.`,
        );
      }
      return res;
    };

    // A truncated (oversized) IMAP fetch has incomplete raw bytes — never partially ticket it.
    // Quarantine before touching external storage; a faithful replay must re-fetch the original.
    if (delivery.truncated) {
      await settle({
        state: 'QUARANTINED',
        lastError:
          'oversized: the fetched raw MIME is truncated at the size ceiling — re-fetch the original message to replay',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      this.logger.error(
        `Inbound delivery ${deliveryId}: QUARANTINED — oversized/truncated IMAP fetch (${delivery.sizeBytes} bytes)`,
      );
      return;
    }

    // `attempts` was already incremented by the claim above. If it now exceeds the budget,
    // earlier claims kept losing their terminal write (processing outlived the lease) — do a
    // FAST quarantine now (a millisecond write, comfortably inside the fresh lease) instead
    // of running the slow processing again and losing another terminal write.
    if (delivery.attempts > this.maxAttempts) {
      await settle({
        state: 'QUARANTINED',
        lastError: `exhausted ${this.maxAttempts} attempts (processing repeatedly exceeded the lease)`,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      this.logger.error(
        `Inbound delivery ${deliveryId}: QUARANTINED — ${delivery.attempts} claims exhausted the attempt budget`,
      );
      return;
    }

    let rawMime: Buffer | null = delivery.rawMime ? Buffer.from(delivery.rawMime) : null;
    try {
      if (!rawMime && delivery.rawStorageKey) {
        if (!this.rawStorage) throw new ServiceUnavailableException('Inbound raw MIME storage unavailable');
        rawMime = await this.rawStorage.read(delivery.rawStorageKey);
      }
    } catch (err) {
      // External storage can be temporarily unavailable. Never leave the row PROCESSING:
      // retry with a lease-fenced backoff, then quarantine at the same attempt budget as the
      // parser path. Durable error text must not expose filesystem/provider internals.
      const exhausted = delivery.attempts >= this.maxAttempts;
      await settle(
        exhausted
          ? {
              state: 'QUARANTINED',
              lastError: 'Inbound raw MIME storage remained unavailable after retry budget',
              leaseOwner: null,
              leaseExpiresAt: null,
            }
          : {
              state: 'RETRY',
              nextAttemptAt: new Date(Date.now() + 60_000 * 2 ** (delivery.attempts - 1)),
              lastError: 'Inbound raw MIME storage temporarily unavailable',
              leaseOwner: null,
              leaseExpiresAt: null,
            },
      );
      this.logger.warn(`Inbound delivery ${deliveryId}: raw storage read failed (${this.errorKind(err)})`);
      return;
    }
    if (!rawMime) {
      await settle({
        state: 'QUARANTINED',
        lastError: 'missing rawMime',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      this.logger.error(`Inbound delivery ${deliveryId}: missing rawMime — quarantined`);
      return;
    }

    // For a legacy epoch-1 IMAP delivery, also dedup against the LEGACY transport Message-ID form
    // (`<imap-<queueId>-<uidValidity>-<uid>@helpdesk.invalid>`) that the pre-ledger poller
    // stamped on header-less mail — otherwise a RESUME_MIGRATED re-fetch of already-ticketed
    // header-less mail would miss dedup (it now hashes to a different synthetic id) and
    // duplicate the ticket.
    const legacyDedupIds: string[] = [];
    if (
      // The old poller encoded no mailbox epoch. Applying this bridge after an identity
      // cutover would make a new mailbox reusing UIDVALIDITY/UID silently look like an
      // old ticketed message, defeating the epoch-aware transport key. The migration puts
      // all pre-ledger rows in epoch 1, so retain compatibility only inside that boundary.
      delivery.transport === 'IMAP' &&
      delivery.mailboxEpoch === 1 &&
      delivery.queueId != null &&
      delivery.uidValidity != null &&
      delivery.uid != null
    ) {
      legacyDedupIds.push(
        `<imap-${delivery.queueId}-${delivery.uidValidity}-${delivery.uid}@helpdesk.invalid>`,
      );
    }

    // Heartbeat: keep extending OUR lease while a healthy-but-slow message is processed
    // (a large parse + attachment upload can approach the lease window). CAS-gated on our
    // token so it no-ops the instant we lose the lease; unref'd so it never holds the event
    // loop open; always cleared in `finally`. This closes the window where a long-but-live
    // flow's lease expired and another worker reclaimed and reprocessed it.
    const heartbeat = setInterval(() => {
      void this.prisma.inboundDelivery
        .updateMany({
          where: { id: deliveryId, leaseOwner: leaseToken, state: 'PROCESSING' },
          data: { leaseExpiresAt: new Date(Date.now() + InboundMailService.LEASE_MS) },
        })
        .catch(() => {
          /* transient; the next tick retries, and settle is CAS-fenced regardless */
        });
    }, InboundMailService.LEASE_MS / 2);
    heartbeat.unref?.();
    // Header-less mail is deliberately idempotent ONLY by transport identity. Do not seed an
    // id from `contentHash`: two distinct IMAP UIDs carrying identical bytes are independent
    // deliveries and must create two tickets. `transportKey` contains the full IMAP identity
    // (including mailbox epoch after P0-A) and the trusted PIPE delivery identity after P1-G.
    const syntheticSeed = delivery.transportKey;
    try {
      const outcome = await this.processRawMessage(rawMime, departmentId, {
        deliveryId,
        leaseToken,
        legacyDedupIds,
        syntheticSeed,
        deliveryContext: {
          queueId: delivery.queueId ?? undefined,
          transportKey: delivery.transportKey,
          envelopeTo: delivery.envelopeTo ?? undefined,
          routedQueueId: delivery.routedQueueId ?? undefined,
          routedDepartmentId: delivery.routedDepartmentId ?? undefined,
          sendAutoresponder: delivery.sendAutoresponder,
          routingSnapshot: this.normalizeRoutingSnapshot(delivery.routingSnapshot),
        },
      });
      await settle({
        state: outcome.state,
        ticketId: outcome.ticketId ?? null,
        postId: outcome.postId ?? null,
        ...(outcome.ticketId != null
          ? {
              effectiveOwnerKind: 'TICKET' as const,
              effectiveOwnerTicketId: outcome.ticketId,
            }
          : {}),
        processedAt: new Date(),
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    } catch (err) {
      const attempts = delivery.attempts; // already incremented by the claim CAS
      const safeError = this.safeProcessingError(err);
      // A ticket may have been created/replied to before the authoritative ACL relation could
      // be persisted. Do not leave that raw MIME visible through its earlier route while a
      // retry resolves the durable ticket owner; fail closed for every scoped operator.
      const failClosedOwner =
        err instanceof EffectiveOwnerResolutionError
          ? {
              effectiveOwnerKind: 'UNRESOLVED' as const,
              effectiveOwnerDepartmentId: null,
              effectiveOwnerTicketId: null,
            }
          : {};
      // A malformed / oversized message fails deterministically — quarantine it at once
      // (raw MIME retained) instead of burning every retry on an error that cannot pass.
      if (this.isPermanentProcessingError(err) || attempts >= this.maxAttempts) {
        await settle({
          state: 'QUARANTINED',
          attempts,
          lastError: safeError,
          ...failClosedOwner,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        this.logger.error(
          `Inbound delivery ${deliveryId}: QUARANTINED after ${attempts} attempt(s) ` +
            `(raw MIME retained for replay; ${this.errorKind(err)})`,
        );
      } else {
        const backoffMs = 60_000 * 2 ** (attempts - 1);
        await settle({
          state: 'RETRY',
          attempts,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          lastError: safeError,
          ...failClosedOwner,
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        this.logger.warn(
          `Inbound delivery ${deliveryId}: retry ${attempts}/${this.maxAttempts} in ${backoffMs}ms ` +
            `(${this.errorKind(err)})`,
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Persist small raw MIME inline for low-latency ledger reads. A large MIME first takes a
   * short, committed, queue-bound staging reservation under the capture lifecycle fence, then
   * writes outside an interactive transaction. This avoids a slow filesystem write consuming
   * Prisma's default interactive-transaction timeout while still making capture arming see
   * every pending file before it can retire a queue.
   */
  private async persistRawMime(
    source: Buffer,
    queueId: number,
    expectCaptureRetired: boolean,
  ): Promise<PersistedRawMime> {
    if (source.length <= MAX_INLINE_RAW_MIME_BYTES) {
      // Prisma's Bytes input intentionally requires an ArrayBuffer-backed view.
      // Node Buffers can instead carry the broader ArrayBufferLike type.
      const rawMime = new Uint8Array(new ArrayBuffer(source.byteLength));
      rawMime.set(source);
      return { rawMime, rawStorageKey: null };
    }
    if (!this.rawStorage) {
      throw new ServiceUnavailableException('Inbound raw MIME storage is unavailable for a large message');
    }
    const rawStorageKey = this.rawStorage.allocateKey();
    try {
      await this.reserveRawMimeStage(queueId, rawStorageKey, expectCaptureRetired);
      await this.rawStorage.writeFenced(source, rawStorageKey, async (publish) => {
        await this.publishRawMimeStage(rawStorageKey, publish);
      });
      return { rawMime: null, rawStorageKey };
    } catch (err) {
      await this.discardRawStage(rawStorageKey);
      throw err;
    }
  }

  /**
   * Commit a queue-bound raw-MIME reservation before file I/O. `armCaptureQueue()` locks this
   * same queue row and rejects any surviving reservation, so the two operations serialize:
   * capture wins before reservation (no raw bytes are written), or the reservation wins and
   * capture remains closed until its file and marker have been removed.
   */
  private async reserveRawMimeStage(
    queueId: number,
    storageKey: string,
    expectCaptureRetired: boolean,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // `queueId` is a foreign key on the stage row. NO KEY UPDATE preserves the
      // capture-arm serialization (arm takes FOR UPDATE) while permitting PostgreSQL's
      // internal FK KEY SHARE check for this child insert in the same short transaction.
      const queues = await tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT "id"
        FROM "EmailQueue"
        WHERE "id" = ${queueId}
          AND "isEnabled" = true
          ${
            expectCaptureRetired
              ? Prisma.sql`AND "captureRetiredAt" IS NOT NULL`
              : Prisma.sql`AND "captureRetiredAt" IS NULL`
          }
        FOR NO KEY UPDATE
      `);
      if (!queues[0]) {
        throw new ConflictException(
          'Inbound queue changed before raw MIME staging; retry after reloading the queue state',
        );
      }
      await tx.inboundRawMimeStaging.create({
        data: {
          storageKey,
          queueId,
          state: 'ACTIVE',
          leaseExpiresAt: new Date(Date.now() + InboundMailService.RAW_STAGING_LEASE_MS),
        },
      });
    });
  }

  /**
   * Keep the staging-row lock only around the final rename, never around the potentially slow
   * raw write. If reaping won while the writer was producing its private temporary file, this
   * throws before publish; if the writer wins, it refreshes ACTIVE's lease atomically with the
   * rename so a reaper cannot delete bytes in the hand-off to final acceptance.
   */
  private async publishRawMimeStage(storageKey: string, publish: () => Promise<void>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ storageKey: string }>>(Prisma.sql`
        SELECT "storageKey"
        FROM "InboundRawMimeStaging"
        WHERE "storageKey" = ${storageKey}
          AND "state" = 'ACTIVE'
        FOR UPDATE
      `);
      if (!rows[0]) {
        throw new ServiceUnavailableException(
          'Inbound raw MIME writer lost its staging fence before publish',
        );
      }
      await publish();
      const refreshed = await tx.inboundRawMimeStaging.updateMany({
        where: { storageKey, state: 'ACTIVE' },
        data: { leaseExpiresAt: new Date(Date.now() + InboundMailService.RAW_STAGING_LEASE_MS) },
      });
      if (refreshed.count !== 1) {
        throw new ServiceUnavailableException('Inbound raw MIME staging fence changed during publish');
      }
    });
  }

  /**
   * Discard a failed/duplicate write. Commit REAPING before touching the filesystem: if the
   * later delete fails, the durable state continues to reject acceptance rather than allowing a
   * stale ACTIVE reservation to point a delivery at bytes that may already be gone.
   */
  private async discardRawStage(rawStorageKey: string | null): Promise<void> {
    if (!rawStorageKey) return;
    const rawStorage = this.rawStorage;
    if (!rawStorage) {
      this.logger.warn('Inbound raw MIME staged-file cleanup deferred (storage unavailable)');
      return;
    }
    try {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ storageKey: string }>>(Prisma.sql`
          SELECT "storageKey"
          FROM "InboundRawMimeStaging"
          WHERE "storageKey" = ${rawStorageKey}
            AND "state" = 'ACTIVE'
          FOR UPDATE
        `);
        if (!rows[0]) return false;
        const transitioned = await tx.inboundRawMimeStaging.updateMany({
          where: { storageKey: rawStorageKey, state: 'ACTIVE' },
          data: { state: 'REAPING' },
        });
        if (transitioned.count !== 1) {
          throw new ServiceUnavailableException('Inbound raw MIME stage changed during discard');
        }
        return true;
      });
      if (!claimed) return;
    } catch (err) {
      this.logger.warn(`Inbound raw MIME stage claim deferred (${this.errorKind(err)})`);
      return;
    }
    try {
      await rawStorage.removeFile(rawStorageKey);
    } catch (err) {
      this.logger.warn(`Inbound raw MIME staged-file cleanup deferred (${this.errorKind(err)})`);
      return;
    }
    try {
      const removed = await this.prisma.inboundRawMimeStaging.deleteMany({
        where: { storageKey: rawStorageKey, state: 'REAPING' },
      });
      if (removed.count !== 1) return;
    } catch (err) {
      this.logger.warn(`Inbound raw MIME stage cleanup deferred (${this.errorKind(err)})`);
      return;
    }
    await rawStorage.commit(rawStorageKey).catch((err) => {
      this.logger.warn(`Inbound raw MIME staged-marker cleanup deferred (${this.errorKind(err)})`);
    });
  }

  /** Lock an ACTIVE durable stage while the same transaction creates its ledger pointer. */
  private async lockRawStageForAcceptance(
    tx: Prisma.TransactionClient,
    rawStorageKey: string | null,
  ): Promise<void> {
    if (!rawStorageKey) return;
    const rows = await tx.$queryRaw<Array<{ storageKey: string }>>(Prisma.sql`
      SELECT "storageKey"
      FROM "InboundRawMimeStaging"
      WHERE "storageKey" = ${rawStorageKey}
        AND "state" = 'ACTIVE'
      FOR UPDATE
    `);
    if (!rows[0]) {
      throw new ServiceUnavailableException(
        'Inbound raw MIME staging fence is unavailable before acceptance',
      );
    }
  }

  /** Make the successful ledger pointer and its stage state durable in one transaction. */
  private async markRawStageCommitted(
    tx: Prisma.TransactionClient,
    rawStorageKey: string | null,
  ): Promise<void> {
    if (!rawStorageKey) return;
    const transitioned = await tx.inboundRawMimeStaging.updateMany({
      where: { storageKey: rawStorageKey, state: 'ACTIVE' },
      data: { state: 'COMMITTED' },
    });
    if (transitioned.count !== 1) {
      throw new ServiceUnavailableException('Inbound raw MIME staging fence changed before ledger commit');
    }
  }

  /**
   * Finish the marker/stage handshake after the ledger transaction has committed. A failure is
   * intentionally advisory: COMMITTED stays durable and the bounded reaper later verifies the
   * delivery pointer before finalizing it. Never turn a successful acceptance into a retry that
   * could duplicate its ticket/outbox side effects.
   */
  private async finalizeAcceptedRawStage(rawStorageKey: string | null): Promise<void> {
    if (!rawStorageKey) return;
    const rawStorage = this.rawStorage;
    if (!rawStorage) {
      this.logger.warn('Inbound raw MIME marker finalization deferred (storage unavailable)');
      return;
    }
    try {
      await rawStorage.commit(rawStorageKey);
    } catch (err) {
      this.logger.warn(`Inbound raw MIME marker commit deferred (${this.errorKind(err)})`);
      return;
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ state: 'COMMITTED' | 'REAPING' | 'ACTIVE' }>>(Prisma.sql`
          SELECT "state"
          FROM "InboundRawMimeStaging"
          WHERE "storageKey" = ${rawStorageKey}
          FOR UPDATE
        `);
        const stage = rows[0];
        const reference = await tx.inboundDelivery.findFirst({
          where: { rawStorageKey },
          select: { id: true },
        });
        if (!reference) {
          throw new ServiceUnavailableException(
            'Inbound raw MIME ledger pointer missing during finalization',
          );
        }
        // A concurrent reaper may already have verified the same pointer and removed the
        // stage. That is a successful, idempotent finalization.
        if (!stage) return;
        if (stage.state !== 'COMMITTED') {
          throw new ServiceUnavailableException('Inbound raw MIME stage is not COMMITTED after acceptance');
        }
        const removed = await tx.inboundRawMimeStaging.deleteMany({
          where: { storageKey: rawStorageKey, state: 'COMMITTED' },
        });
        if (removed.count !== 1) {
          throw new ServiceUnavailableException('Inbound raw MIME stage changed during finalization');
        }
      });
    } catch (err) {
      this.logger.warn(`Inbound raw MIME stage finalization deferred (${this.errorKind(err)})`);
    }
  }

  /**
   * Transport collisions are rejected to the MTA, but must also be durable/visible to an
   * operator: a repeated delivery id with different bytes could otherwise look like an ordinary
   * HTTP failure in mail logs. Audit write failure does not turn the collision into success.
   */
  private async recordInboundCollision(input: {
    queueId: number;
    deliveryId?: number;
    contentHash: string;
    priorContentHash?: string;
    reason: string;
  }): Promise<void> {
    try {
      await this.prisma.inboundAuditLog.create({
        data: {
          actorEmail: 'system',
          action: 'mail.transport_collision',
          queueId: input.queueId,
          deliveryId: input.deliveryId ?? null,
          reason: input.reason,
          metadata: {
            transport: 'PIPE',
            incomingContentHash: input.contentHash,
            priorContentHash: input.priorContentHash ?? null,
          },
        },
      });
    } catch (err) {
      this.logger.error(
        `INBOUND ALERT transport collision queue=${input.queueId}: audit write failed (${this.errorKind(err)})`,
      );
    }
    this.logger.error(`INBOUND ALERT transport collision queue=${input.queueId}: ${input.reason}`);
  }

  // ─────────────────── routing pipeline ───────────────────

  /**
   * Parse a raw RFC822 message and route it (thread / new ticket). Returns the terminal
   * outcome for the ledger. Throws on transient/DB errors so the caller retries (never
   * swallowed). Shared by the IMAP drain and the PIPE ingress.
   */
  private async processRawMessage(
    source: Buffer | string,
    departmentId: number | undefined,
    opts: {
      deliveryId?: number;
      /** The active ledger lease fences effective-owner changes to this claim. */
      leaseToken?: string;
      legacyDedupIds?: string[];
      /** Stable transport identity used only for the ticket-post retry key of headerless mail. */
      syntheticSeed?: string;
      /** Immutable transport/route snapshot read from the ledger row that owns this attempt. */
      deliveryContext?: DeliveryRoutingContext;
    } = {},
  ): Promise<ProcessOutcome> {
    const { deliveryId, leaseToken, legacyDedupIds = [], syntheticSeed, deliveryContext } = opts;
    // Reject oversized raw before parsing (an IMAP fetch capped at the size limit + 1 byte
    // arrives here truncated; the PIPE path already rejects at ingress).
    const sourceBytes = typeof source === 'string' ? Buffer.byteLength(source) : source.length;
    if (sourceBytes > this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024) {
      throw new PayloadTooLargeException('Inbound message exceeds the configured size limit');
    }

    // Parse under a bounded concurrency permit, then reject parser-amplified fields before
    // they reach routing, storage, or the regex parser rules.
    const parsed = await this.withParserSlot(async () => {
      const { simpleParser } = await import('mailparser');
      return simpleParser(source);
    });
    const realMessageId = this.resolveRealMessageId(parsed);
    this.validateParsedMail(parsed);

    const subject = (parsed.subject ?? '(no subject)').trim() || '(no subject)';
    const from = parsed.from?.value?.[0];
    const fromEmail = normalizeEmail(from?.address ?? '');
    if (!this.isPlausibleEmail(fromEmail)) {
      throw new BadRequestException('Inbound message has no valid From address');
    }
    const fromName = (from?.name ?? fromEmail).trim() || fromEmail;
    const toField = parsed.to;
    const toAddress =
      normalizeEmail(
        (!Array.isArray(toField) ? toField?.value?.[0]?.address : toField?.[0]?.value?.[0]?.address) ?? '',
      ) || undefined;
    // The envelope recipient is a trusted transport snapshot (needed for BCC routing). Never
    // overwrite it with the visible To header when processing an already-accepted delivery.
    const persistedEnvelopeTo = deliveryContext?.envelopeTo ?? toAddress;
    const rawBuf = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    const semanticHash = this.computeSemanticHash(parsed);
    let route: InboundRoute = { departmentId, fallback: false };
    let winnerClaim: LogicalClaimWinner | undefined;

    // Every ledger delivery records the observed real Message-ID (if present), semantic hash,
    // and deterministic business route BEFORE loop/rule/ticket decisions. That makes CC copies,
    // parser skips, and quarantined semantic conflicts forensic-visible rather than invisible
    // side effects of a unique field on InboundDelivery.
    if (deliveryId != null) {
      const proposedRoute = await this.resolveInboundRoute(parsed, deliveryContext, departmentId);
      if (realMessageId) {
        const claim = await this.claimRealMessage({
          deliveryId,
          leaseToken,
          messageId: realMessageId,
          semanticHash,
          route: proposedRoute,
          deliveryContext,
          envelopeFrom: fromEmail,
          envelopeTo: persistedEnvelopeTo,
          subject,
        });
        if (claim.kind === 'DUPLICATE') {
          // A finished winner makes the ticket relation the only non-admin ACL authority for
          // this CC/transport copy as well. If the winner has not finished yet, leave this
          // row UNRESOLVED; `finalize` bulk-promotes only same-semantic siblings atomically.
          if (claim.ticketId != null) {
            await this.persistEffectiveTicketOwner(deliveryId, claim.ticketId, leaseToken);
          }
          this.logger.log(`Inbound: logical duplicate ${realMessageId} from ${fromEmail} — skipped`);
          return { state: 'SKIPPED', ...(claim.ticketId != null ? { ticketId: claim.ticketId } : {}) };
        }
        if (claim.kind === 'CONFLICT') {
          this.logger.error(
            `Inbound: Message-ID semantic conflict ${realMessageId} delivery=${deliveryId} ` +
              `(existing=${claim.existingSemanticHash ?? 'legacy/unknown'})`,
          );
          throw new SemanticMessageIdConflictError(
            'Message-ID was already claimed by different or unreconstructable logical content',
          );
        }
        route = claim.winner.route;
        winnerClaim = claim.winner;
      } else {
        route = await this.recordHeaderlessDelivery({
          deliveryId,
          leaseToken,
          semanticHash,
          route: proposedRoute,
          deliveryContext,
          envelopeFrom: fromEmail,
          envelopeTo: persistedEnvelopeTo,
          subject,
        });
      }
      // The deterministic route is enough to scope parse/retry failures that occur before a
      // thread or parser rule selects a more specific ticket department. Preserve a prior
      // TICKET owner on a retry; that owner must follow its ticket if it later moves.
      await this.persistEffectiveOwner(
        deliveryId,
        { kind: 'ROUTED', departmentId: route.departmentId },
        leaseToken,
        {
          preserveTicket: true,
        },
      );
    }

    // True Message-IDs key the inbound ticket-post idempotency backstop. Headerless mail gets a
    // per-transport synthetic key: identical bytes on different IMAP UIDs intentionally do
    // NOT collide, while a retry of the same ledger row still cannot create another post.
    const seed: string | Buffer = syntheticSeed ?? rawBuf;
    const effectiveMessageId =
      realMessageId ?? `<inbound-${createHash('sha256').update(seed).digest('hex')}@23telecom.local>`;

    const finalize = async (outcome: ProcessOutcome): Promise<ProcessOutcome> => {
      if (winnerClaim && deliveryId != null && (outcome.ticketId != null || outcome.postId != null)) {
        await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          const updated = await tx.inboundMessageClaim.updateMany({
            where: {
              messageIdHash: winnerClaim.messageIdHash,
              winnerDeliveryId: deliveryId,
            },
            data: {
              ticketId: outcome.ticketId ?? null,
              postId: outcome.postId ?? null,
            },
          });
          if (updated.count !== 1) {
            throw new ServiceUnavailableException(
              `Logical Message-ID claim ${winnerClaim.messageIdHash} changed before finalization`,
            );
          }
          // A common Message-ID alone is not sufficient: only a matching semantic hash proves
          // that a sibling is the same logical message. Keep this propagation transactional so
          // a completed ticket can never leave a same-message CC copy scoped to its old route.
          if (outcome.ticketId != null) {
            await tx.inboundDelivery.updateMany({
              where: {
                messageIdHash: winnerClaim.messageIdHash,
                semanticHash: winnerClaim.semanticHash,
              },
              data: {
                effectiveOwnerKind: 'TICKET',
                effectiveOwnerTicketId: outcome.ticketId,
              },
            });
          }
        });
      }
      return outcome;
    };

    // A5(ii): drop machine-generated / looping mail before it can create a ticket/reply. The
    // delivery/claim was intentionally recorded above, so a loop is auditable and idempotent.
    if (this.isLoopMessage(parsed, fromEmail)) {
      this.logger.log('Inbound: skipped auto/loop message');
      return finalize({ state: 'SKIPPED' });
    }

    // Secondary fast dedup: only an inbound post bearing this idempotency key proves this
    // message was ingested before (e.g. a retry after post creation, or — via
    // `legacyDedupIds` — the pre-ledger poller already ticketed this IMAP UID). Do not query
    // TicketPost.messageId here: it is a threading namespace and an attacker can reuse a
    // staff outbound Message-ID. Returns the existing ids for observability.
    const dedupIds = [effectiveMessageId, ...legacyDedupIds];
    const existing = await this.prisma.ticketPost.findFirst({
      where: { inboundMessageId: { in: dedupIds } },
      select: { id: true, ticketId: true },
    });
    if (existing) {
      await this.persistEffectiveTicketOwner(deliveryId, existing.ticketId, leaseToken);
      this.logger.log(`Inbound: duplicate message ${effectiveMessageId} from ${fromEmail} — skipped`);
      return finalize({ state: 'SKIPPED', ticketId: existing.ticketId, postId: existing.id });
    }

    const textBody = stripQuotedReply(parsed.text ?? '');
    const htmlBody = parsed.html || undefined;

    // #9: stage attachments LAZILY — only upload when we are actually about to reply or
    // create a ticket. Loop/duplicate/parser-ignore messages return before this runs, so
    // they never leave orphan attachment files. Memoised so it uploads at most once.
    let stagedAttachmentIds: number[] | null = null;
    const attachmentIds = async (): Promise<number[]> => {
      if (stagedAttachmentIds) return stagedAttachmentIds;
      stagedAttachmentIds = [];
      if (this.attachmentsService && parsed.attachments?.length) {
        const uploaded = await this.attachmentsService.uploadFiles(
          parsed.attachments
            .filter((a) => a.content instanceof Buffer)
            .map((a) => ({
              originalname: a.filename ?? 'attachment',
              mimetype: a.contentType ?? 'application/octet-stream',
              size: (a.content as Buffer).length,
              buffer: a.content as Buffer,
            })),
          { source: 'inbound' },
        );
        stagedAttachmentIds = uploaded.map((a) => a.id);
      }
      return stagedAttachmentIds;
    };

    // RFC threading identifiers. Filter empties so a blank id can never match the ''
    // default on legacy posts.
    const inReplyTo = this.normalizeMessageId(parsed.inReplyTo);
    const referencedIds: string[] = [];
    if (inReplyTo) referencedIds.push(inReplyTo);
    for (const ref of this.referenceValues(parsed.references)) {
      const normalized = this.normalizeMessageId(ref);
      if (normalized) referencedIds.push(normalized);
    }
    const cleanReferencedIds = [...new Set(referencedIds)].slice(0, MAX_REFERENCES);

    // 1. Thread by In-Reply-To / References. Possession of a real Message-ID is strong, but
    // still require the sender to be a ticket participant (requester / linked user account /
    // recipient) so a leaked Message-ID cannot be used to append to another customer's ticket.
    if (cleanReferencedIds.length > 0) {
      const linkedPost = await this.prisma.ticketPost.findFirst({
        where: { messageId: { in: cleanReferencedIds } },
        include: {
          ticket: {
            include: {
              user: { select: { emails: { select: { email: true } } } },
              recipients: { select: { email: true } },
            },
          },
        },
      });
      if (linkedPost && this.senderCanReply(linkedPost.ticket as ThreadableTicket, fromEmail)) {
        await this.persistEffectiveOwner(
          deliveryId,
          { kind: 'TICKET', ticketId: linkedPost.ticketId, departmentId: linkedPost.ticket.departmentId },
          leaseToken,
        );
        const post = await this.ticketsService.reply(linkedPost.ticketId, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: await attachmentIds(),
          incomingMessageId: effectiveMessageId,
        });
        this.logger.log(`Inbound: RFC-threaded reply to ${linkedPost.ticket.mask} from ${fromEmail}`);
        return finalize({ state: 'PROCESSED', ticketId: linkedPost.ticketId, postId: post.id });
      }
      if (linkedPost) {
        this.logger.warn('Inbound: RFC-thread sender not authorized for the ticket — creating new');
      }
    }

    // 2. Thread by subject mask — a mask is guessable, so require the sender to be a ticket
    // participant (requester / linked user account / recipient). Not found or unauthorized →
    // new ticket; a DB error propagates so the delivery is retried, never silently duplicated.
    const maskMatch = MASK_RE.exec(subject);
    if (maskMatch) {
      const mask = maskMatch[0].toUpperCase();
      const maskTicket = await this.prisma.ticket.findUnique({
        where: { mask },
        select: {
          id: true,
          departmentId: true,
          requesterEmail: true,
          user: { select: { emails: { select: { email: true } } } },
          recipients: { select: { email: true } },
        },
      });
      if (maskTicket && this.senderCanReply(maskTicket, fromEmail)) {
        await this.persistEffectiveOwner(
          deliveryId,
          { kind: 'TICKET', ticketId: maskTicket.id, departmentId: maskTicket.departmentId },
          leaseToken,
        );
        const post = await this.ticketsService.reply(maskTicket.id, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: await attachmentIds(),
          incomingMessageId: effectiveMessageId,
        });
        this.logger.log(`Inbound: threaded reply to ${mask} from ${fromEmail}`);
        return finalize({ state: 'PROCESSED', ticketId: maskTicket.id, postId: post.id });
      }
      this.logger.warn(
        maskTicket
          ? `Inbound: mask ${mask} sender not authorized — creating new ticket`
          : `Inbound: mask ${mask} did not resolve — creating new ticket`,
      );
    }

    // 3. PRE_PARSE parser rules (before creating a new ticket)
    const parsedEmail: ParsedEmail = { subject, fromEmail, fromName, toEmail: toAddress, body: textBody };
    const routedDepartmentId = route.departmentId ?? departmentId;
    const ruleResult = await this.applyParserRules(parsedEmail, routedDepartmentId);
    if (ruleResult.skip) {
      this.logger.log(`Inbound: message from ${fromEmail} discarded by parser rule — "${subject}"`);
      return finalize({ state: 'SKIPPED' });
    }

    // 4. Create a new ticket. Message-ID written atomically with the first post.
    const deptId = ruleResult.departmentId ?? routedDepartmentId ?? (await this.defaultDeptId());
    await this.persistEffectiveOwner(deliveryId, { kind: 'ROUTED', departmentId: deptId }, leaseToken);
    const newTicket = await this.ticketsService.createTicket({
      subject,
      contents: htmlBody ?? textBody,
      isHtml: !!htmlBody,
      departmentId: deptId,
      requesterEmail: fromEmail,
      requesterName: fromName,
      creationMode: 'EMAIL',
      ipAddress: '0.0.0.0',
      tags: ruleResult.tags,
      customFields: {},
      attachmentIds: await attachmentIds(),
      incomingMessageId: effectiveMessageId,
      // The deterministic owner selected from the immutable acceptance snapshot controls
      // both ticket attribution and the customer-autoresponder policy. A historical/unknown
      // row deliberately leaves this undefined; TicketsService then fails closed rather than
      // consulting a currently unrelated queue by department.
      ...(route.queueId != null ? { inboundQueueId: route.queueId } : {}),
      ...(route.sendAutoresponder !== undefined ? { inboundSendAutoresponder: route.sendAutoresponder } : {}),
      ...(ruleResult.priorityId !== undefined ? { priorityId: ruleResult.priorityId } : {}),
      ...(ruleResult.ownerStaffId !== undefined ? { ownerStaffId: ruleResult.ownerStaffId } : {}),
    });
    // Do this before any follow-up query/finalize step. If the process crashes after the ticket
    // exists, its raw delivery still follows the ticket rather than its pre-create route.
    await this.persistEffectiveTicketOwner(deliveryId, newTicket.id, leaseToken);
    const firstPost = await this.prisma.ticketPost.findFirst({
      where: { ticketId: newTicket.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    this.logger.log(`Inbound: new ticket ${newTicket.mask} from ${fromEmail} — "${subject}"`);
    return finalize({ state: 'PROCESSED', ticketId: newTicket.id, postId: firstPost?.id });
  }

  /**
   * The delivery's actual ticket owner is an ACL fence, not merely observability. Write it
   * before any reply/ticket side effect and CAS it to this processing lease, so a stale worker
   * cannot relabel a delivery reclaimed by another pod.
   */
  private async persistEffectiveOwner(
    deliveryId: number | undefined,
    owner:
      | { kind: 'ROUTED'; departmentId: number | undefined }
      | { kind: 'TICKET'; ticketId: number; departmentId?: number },
    leaseToken: string | undefined,
    options: { preserveTicket?: boolean } = {},
  ): Promise<void> {
    // processRawMessage is private and production always calls it from a claimed delivery.
    // A few legacy direct unit helpers lack a lease; leaving their owner UNRESOLVED is safer
    // than writing an unfenced owner and does not widen any non-admin API access.
    if (deliveryId === undefined || !leaseToken) return;
    if (
      (owner.kind === 'ROUTED' &&
        (owner.departmentId === undefined ||
          !Number.isSafeInteger(owner.departmentId) ||
          owner.departmentId < 1)) ||
      (owner.kind === 'TICKET' &&
        (!Number.isSafeInteger(owner.ticketId) ||
          owner.ticketId < 1 ||
          (owner.departmentId !== undefined &&
            (!Number.isSafeInteger(owner.departmentId) || owner.departmentId < 1))))
    ) {
      throw new EffectiveOwnerResolutionError(deliveryId);
    }
    const updated = await this.prisma.inboundDelivery.updateMany({
      where: {
        id: deliveryId,
        state: 'PROCESSING',
        leaseOwner: leaseToken,
        ...(options.preserveTicket ? { effectiveOwnerKind: { not: 'TICKET' } } : {}),
      },
      data:
        owner.kind === 'TICKET'
          ? {
              effectiveOwnerKind: 'TICKET',
              ...(owner.departmentId !== undefined ? { effectiveOwnerDepartmentId: owner.departmentId } : {}),
              effectiveOwnerTicketId: owner.ticketId,
            }
          : {
              effectiveOwnerKind: 'ROUTED',
              effectiveOwnerDepartmentId: owner.departmentId,
              effectiveOwnerTicketId: null,
            },
    });
    if (updated.count === 1) return;
    if (options.preserveTicket) {
      const retainedTicketOwner = await this.prisma.inboundDelivery.findFirst({
        where: { id: deliveryId, state: 'PROCESSING', leaseOwner: leaseToken, effectiveOwnerKind: 'TICKET' },
        select: { id: true },
      });
      if (retainedTicketOwner) return;
    }
    throw new EffectiveOwnerResolutionError(deliveryId);
  }

  /** Set a ticket-owned ACL without trusting a stale department snapshot. */
  private async persistEffectiveTicketOwner(
    deliveryId: number | undefined,
    ticketId: number,
    leaseToken: string | undefined,
  ): Promise<void> {
    await this.persistEffectiveOwner(deliveryId, { kind: 'TICKET', ticketId }, leaseToken);
  }

  // ─────────────────── logical Message-ID claim + deterministic route ───────────────────

  /**
   * Select the business owner. Ledger-backed deliveries route only against their immutable
   * acceptance-time queue snapshot, so equal RFC Message-ID copies resolve to the same
   * `(routingPriority, id)` winner regardless of drain order. Direct (non-ledger) callers
   * retain a current enabled-queue lookup for backwards compatibility.
   */
  private async resolveInboundRoute(
    parsed: ParsedMail,
    context: DeliveryRoutingContext | undefined,
    fallbackDepartmentId: number | undefined,
  ): Promise<InboundRoute> {
    const recipients = new Set<string>();
    for (const field of [parsed.to, parsed.cc]) {
      for (const entry of this.addressEntries(field)) {
        const email = normalizeEmail(entry.address ?? '');
        if (email) recipients.add(email);
      }
    }
    const envelopeRecipient = normalizeEmail(context?.envelopeTo ?? '');
    if (envelopeRecipient) recipients.add(envelopeRecipient);

    // No queue may be re-read while draining a ledger row.  The acceptance snapshot carries
    // every enabled address/policy needed to make the documented deterministic choice even
    // when two CC copies are claimed in the opposite order by separate workers.
    // `queueId` can be nulled by an intentional queue deletion (the ledger retains the raw
    // delivery for replay), whereas `transportKey` is immutable. Use the latter to recognize
    // a ledger row so deletion can never make a queued delivery fall back to live routing.
    if (context?.transportKey !== undefined) {
      const matched = (context.routingSnapshot ?? [])
        .filter((queue) => recipients.has(normalizeEmail(queue.emailAddress)))
        .sort((a, b) => a.routingPriority - b.routingPriority || a.id - b.id);
      const winner = matched[0];
      if (winner) {
        return {
          queueId: winner.id,
          departmentId: winner.departmentId ?? fallbackDepartmentId,
          sendAutoresponder: winner.sendAutoresponder,
          fallback: false,
        };
      }

      // Old ledger rows predate `routingSnapshot`. Their accepting queue/department is the
      // only immutable information available, so retain that conservative legacy fallback;
      // never query today's queue configuration and accidentally reroute historical mail.
      return {
        queueId: context.routedQueueId ?? context.queueId,
        departmentId: context.routedDepartmentId ?? fallbackDepartmentId,
        ...(context.sendAutoresponder !== undefined && context.sendAutoresponder !== null
          ? { sendAutoresponder: context.sendAutoresponder }
          : {}),
        fallback: true,
        fallbackReason: 'RECEIVING_QUEUE',
      };
    }

    const queues = await this.prisma.emailQueue.findMany({
      where: { isEnabled: true, captureRetiredAt: null },
      select: {
        id: true,
        emailAddress: true,
        departmentId: true,
        routingPriority: true,
        sendAutoresponder: true,
      },
    });
    const matched = queues
      .filter((queue) => recipients.has(normalizeEmail(queue.emailAddress)))
      .sort((a, b) => a.routingPriority - b.routingPriority || a.id - b.id);
    const winner = matched[0];
    if (winner) {
      return {
        queueId: winner.id,
        departmentId: winner.departmentId ?? fallbackDepartmentId,
        sendAutoresponder: winner.sendAutoresponder,
        fallback: false,
      };
    }

    return {
      departmentId: fallbackDepartmentId ?? (await this.defaultDeptId()),
      fallback: true,
      fallbackReason: 'DEFAULT_DEPARTMENT',
    };
  }

  /** Validate the JSON persisted at acceptance before it participates in routing. */
  private normalizeRoutingSnapshot(value: Prisma.JsonValue | null | undefined): RoutingSnapshotEntry[] {
    if (!Array.isArray(value)) return [];
    const ids = new Set<number>();
    const result: RoutingSnapshotEntry[] = [];
    for (const valueEntry of value) {
      if (!valueEntry || typeof valueEntry !== 'object' || Array.isArray(valueEntry)) continue;
      const entry = valueEntry as Record<string, unknown>;
      const id = entry['id'];
      const emailAddress = entry['emailAddress'];
      const departmentId = entry['departmentId'];
      const routingPriority = entry['routingPriority'];
      const sendAutoresponder = entry['sendAutoresponder'];
      if (
        !Number.isSafeInteger(id) ||
        (id as number) <= 0 ||
        ids.has(id as number) ||
        typeof emailAddress !== 'string' ||
        normalizeEmail(emailAddress) === '' ||
        !(departmentId === null || (Number.isSafeInteger(departmentId) && (departmentId as number) > 0)) ||
        !Number.isSafeInteger(routingPriority) ||
        (routingPriority as number) < 0 ||
        typeof sendAutoresponder !== 'boolean'
      ) {
        continue;
      }
      ids.add(id as number);
      result.push({
        id: id as number,
        emailAddress,
        departmentId: departmentId as number | null,
        routingPriority: routingPriority as number,
        sendAutoresponder,
      });
    }
    return result.sort((a, b) => a.routingPriority - b.routingPriority || a.id - b.id);
  }

  /**
   * Create/read the durable logical claim inside one database transaction. A unique hash
   * collision is resolved by reading the winning claim in the same transaction; only the
   * winner is allowed into ticket routing. A semantic mismatch is durably audited and returned
   * to the caller as a permanent quarantine outcome.
   */
  private async claimRealMessage(args: {
    deliveryId: number;
    leaseToken?: string;
    messageId: string;
    semanticHash: string;
    route: InboundRoute;
    deliveryContext?: DeliveryRoutingContext;
    envelopeFrom: string;
    envelopeTo?: string;
    subject: string;
  }): Promise<LogicalClaimResult> {
    const messageIdHash = createHash('sha256').update(args.messageId).digest('hex');
    return this.prisma.$transaction<LogicalClaimResult>(async (tx: Prisma.TransactionClient) => {
      // Do NOT catch P2002 then read in this transaction: PostgreSQL marks a transaction
      // aborted after a unique violation. `createMany(skipDuplicates)` emits INSERT .. ON
      // CONFLICT DO NOTHING instead, so the subsequent read is valid for both the winner and
      // a concurrent loser (and any other DB failure still propagates/retries).
      await tx.inboundMessageClaim.createMany({
        data: {
          messageIdHash,
          normalizedMessageId: args.messageId,
          semanticHash: args.semanticHash,
          semanticHashVersion: 1,
          winnerDeliveryId: args.deliveryId,
          routedQueueId: args.route.queueId ?? null,
          departmentId: args.route.departmentId ?? null,
          sendAutoresponder: args.route.sendAutoresponder ?? null,
        },
        skipDuplicates: true,
      });
      const claim = await tx.inboundMessageClaim.findUnique({ where: { messageIdHash } });
      if (!claim) {
        // `skipDuplicates` can also be triggered by winnerDeliveryId's unique constraint.
        // If the expected hash is absent, do not assume duplicate semantics; retry/fail closed.
        throw new ServiceUnavailableException(
          `Logical Message-ID claim ${messageIdHash} was not readable after atomic insert`,
        );
      }

      const persistedRoute: InboundRoute = {
        queueId: claim.routedQueueId ?? undefined,
        departmentId: claim.departmentId ?? undefined,
        ...(claim.sendAutoresponder !== null && claim.sendAutoresponder !== undefined
          ? { sendAutoresponder: claim.sendAutoresponder }
          : {}),
        fallback: false,
      };
      await this.recordDeliveryIdentity(tx, {
        deliveryId: args.deliveryId,
        leaseToken: args.leaseToken,
        observedMessageId: args.messageId,
        messageIdHash,
        semanticHash: args.semanticHash,
        route: persistedRoute,
        envelopeFrom: args.envelopeFrom,
        envelopeTo: args.envelopeTo,
        subject: args.subject,
      });

      if (claim.winnerDeliveryId === args.deliveryId) {
        // A retry of the original winner after ticket creation but before settle must retain
        // ownership. A malformed changed raw payload on that same delivery is still unsafe.
        if (claim.semanticHashVersion !== 1 || claim.semanticHash !== args.semanticHash) {
          await this.writeSemanticConflictAudit(tx, args, messageIdHash, claim.semanticHash);
          return { kind: 'CONFLICT', route: persistedRoute, existingSemanticHash: claim.semanticHash };
        }
        if (args.route.fallback) await this.writeRouteFallbackAudit(tx, args.deliveryId, args.route);
        return {
          kind: 'WINNER',
          winner: { messageIdHash, semanticHash: args.semanticHash, route: persistedRoute },
        };
      }

      // A historical claim with no semantic content is intentionally fail-closed. Treating raw
      // bytes as a semantic hash would falsely conflict valid CC copies; treating it as equal
      // would silently discard a genuinely different message that reused a Message-ID.
      if (
        claim.semanticHashVersion !== 1 ||
        !claim.semanticHash ||
        claim.semanticHash !== args.semanticHash
      ) {
        await this.writeSemanticConflictAudit(tx, args, messageIdHash, claim.semanticHash);
        return { kind: 'CONFLICT', route: persistedRoute, existingSemanticHash: claim.semanticHash };
      }

      return { kind: 'DUPLICATE', route: persistedRoute, ticketId: claim.ticketId };
    });
  }

  /** Persist an identity/route for headerless mail without creating a logical claim. */
  private async recordHeaderlessDelivery(args: {
    deliveryId: number;
    leaseToken?: string;
    semanticHash: string;
    route: InboundRoute;
    deliveryContext?: DeliveryRoutingContext;
    envelopeFrom: string;
    envelopeTo?: string;
    subject: string;
  }): Promise<InboundRoute> {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.recordDeliveryIdentity(tx, {
        deliveryId: args.deliveryId,
        leaseToken: args.leaseToken,
        observedMessageId: null,
        messageIdHash: null,
        semanticHash: args.semanticHash,
        route: args.route,
        envelopeFrom: args.envelopeFrom,
        envelopeTo: args.envelopeTo,
        subject: args.subject,
      });
      if (args.route.fallback) await this.writeRouteFallbackAudit(tx, args.deliveryId, args.route);
      return args.route;
    });
  }

  private async recordDeliveryIdentity(
    tx: Prisma.TransactionClient,
    args: {
      deliveryId: number;
      /** Present in real drain/PIPE processing; fences this write to the active lease. */
      leaseToken?: string;
      observedMessageId: string | null;
      messageIdHash: string | null;
      semanticHash: string;
      route: InboundRoute;
      envelopeFrom: string;
      envelopeTo?: string;
      subject: string;
    },
  ): Promise<void> {
    const data = {
      observedMessageId: args.observedMessageId,
      messageIdHash: args.messageIdHash,
      semanticHash: args.semanticHash,
      routedQueueId: args.route.queueId ?? null,
      routedDepartmentId: args.route.departmentId ?? null,
      envelopeFrom: args.envelopeFrom,
      envelopeTo: args.envelopeTo ?? null,
      subject: args.subject.slice(0, MAX_SUBJECT_CHARS),
    };
    // Private direct unit helpers predate the ledger lease. Production calls always carry the
    // token, so an expired/reclaimed worker can never rewrite identity or route snapshots.
    if (!args.leaseToken) {
      await tx.inboundDelivery.update({ where: { id: args.deliveryId }, data });
      return;
    }
    const updated = await tx.inboundDelivery.updateMany({
      where: { id: args.deliveryId, state: 'PROCESSING', leaseOwner: args.leaseToken },
      data,
    });
    if (updated.count !== 1) throw new EffectiveOwnerResolutionError(args.deliveryId);
  }

  private async writeRouteFallbackAudit(
    tx: Prisma.TransactionClient,
    deliveryId: number,
    route: InboundRoute,
  ): Promise<void> {
    await tx.inboundAuditLog.create({
      data: {
        action: 'mail.route_fallback',
        queueId: route.queueId ?? null,
        deliveryId,
        reason: route.fallbackReason ?? 'unknown',
        metadata: {
          routedQueueId: route.queueId ?? null,
          routedDepartmentId: route.departmentId ?? null,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private async writeSemanticConflictAudit(
    tx: Prisma.TransactionClient,
    args: {
      deliveryId: number;
      messageId: string;
      semanticHash: string;
      route: InboundRoute;
      deliveryContext?: DeliveryRoutingContext;
    },
    messageIdHash: string,
    existingSemanticHash: string | null,
  ): Promise<void> {
    await tx.inboundAuditLog.create({
      data: {
        action: 'mail.message_id_conflict',
        queueId: args.route.queueId ?? args.deliveryContext?.queueId ?? null,
        deliveryId: args.deliveryId,
        reason: 'Message-ID reused with different or unreconstructable logical content',
        metadata: {
          messageId: args.messageId,
          messageIdHash,
          incomingSemanticHash: args.semanticHash,
          existingSemanticHash,
        } as Prisma.InputJsonValue,
      },
    });
  }

  /** SHA-256 over logical RFC content only; never raw MIME / per-hop trace headers. */
  private computeSemanticHash(parsed: ParsedMail): string {
    const normalizeText = (value: string | undefined): string =>
      (value ?? '')
        .normalize('NFC')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    const addressField = (field: AddressObject | AddressObject[] | undefined) =>
      this.addressEntries(field)
        .map((entry) => ({
          address: normalizeEmail(entry.address ?? ''),
          name: normalizeText(entry.name).toLowerCase(),
        }))
        .filter((entry) => entry.address)
        .sort((a, b) => `${a.address}\u0000${a.name}`.localeCompare(`${b.address}\u0000${b.name}`));
    const attachmentSummary = (parsed.attachments ?? [])
      .map((attachment) => {
        const content = attachment.content instanceof Buffer ? attachment.content : Buffer.alloc(0);
        const reportedSize = (attachment as { size?: unknown }).size;
        return {
          filename: normalizeText(attachment.filename),
          mimeType: normalizeText(attachment.contentType).toLowerCase(),
          size:
            typeof reportedSize === 'number' && Number.isSafeInteger(reportedSize)
              ? reportedSize
              : content.length,
          hash: createHash('sha256').update(content).digest('hex'),
        };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const canonical = JSON.stringify({
      version: 1,
      from: addressField(parsed.from),
      to: addressField(parsed.to),
      cc: addressField(parsed.cc),
      replyTo: addressField(parsed.replyTo),
      subject: normalizeText(parsed.subject),
      text: normalizeText(parsed.text),
      html: normalizeText(typeof parsed.html === 'string' ? parsed.html : undefined),
      attachments: attachmentSummary,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  // ─────────────────── helpers: mailbox / locks ───────────────────

  /** Read UIDVALIDITY / UIDNEXT / EXISTS from the currently-selected mailbox. */
  private readMailboxState(client: ImapFlow): {
    uidValidity?: bigint;
    uidNext?: number;
    exists?: number;
  } {
    const mailbox = (client as { mailbox?: unknown }).mailbox;
    if (!mailbox || typeof mailbox !== 'object') return {};
    const mb = mailbox as { uidValidity?: unknown; uidNext?: unknown; exists?: unknown };
    let uidValidity: bigint | undefined;
    if (typeof mb.uidValidity === 'bigint') uidValidity = mb.uidValidity;
    else if (typeof mb.uidValidity === 'number' && Number.isFinite(mb.uidValidity))
      uidValidity = BigInt(mb.uidValidity);
    const uidNext = typeof mb.uidNext === 'number' && Number.isFinite(mb.uidNext) ? mb.uidNext : undefined;
    const exists = typeof mb.exists === 'number' && Number.isFinite(mb.exists) ? mb.exists : undefined;
    return { uidValidity, uidNext, exists };
  }

  /**
   * Highest currently-existing UID: `uidNext-1` when advertised, else the max UID from a
   * `*` fetch, else 0 for an empty mailbox. `null` only when it truly can't be resolved.
   */
  private async resolveHighWaterUid(
    client: ImapFlow,
    uidNext: number | undefined,
    exists: number | undefined,
  ): Promise<number | null> {
    if (uidNext !== undefined) return Math.max(uidNext - 1, 0);
    if (exists === 0) return 0;
    try {
      let hi = 0;
      for await (const m of client.fetch('*', { uid: true }, { uid: true })) {
        if (typeof m.uid === 'number' && m.uid > hi) hi = m.uid;
      }
      return hi;
    } catch {
      return null;
    }
  }

  /** True for a Prisma unique-constraint violation (P2002). */
  private isUniqueViolation(err: unknown): boolean {
    return !!err && typeof err === 'object' && (err as { code?: string }).code === 'P2002';
  }

  // ─────────────────── loop/bounce guard (A5) ───────────────────

  /**
   * A5(ii): true when an inbound message looks machine-generated or self-sent, so we
   * must not auto-reply to it. Checks RFC 3834 Auto-Submitted, Precedence:bulk/list/junk,
   * any X-Loop, and a From that matches our own MAIL_FROM (self-loop).
   */
  private isLoopMessage(parsed: { headers?: Map<string, unknown> }, fromEmail: string): boolean {
    const headers = parsed.headers;
    const get = (k: string): string => {
      if (!headers || typeof headers.get !== 'function') return '';
      const raw = headers.get(k);
      if (raw == null) return '';
      const flat = Array.isArray(raw)
        ? raw.map((v) => (typeof v === 'object' && v ? JSON.stringify(v) : String(v))).join(' ')
        : typeof raw === 'object'
          ? JSON.stringify(raw)
          : String(raw);
      return flat.toLowerCase();
    };
    const hasToken = (headerVal: string, tokens: string[]): boolean => {
      const parts = headerVal.split(/[\s,;]+/).filter(Boolean);
      return parts.some((p) => tokens.includes(p));
    };

    const autoSubmitted = get('auto-submitted');
    if (autoSubmitted && !hasToken(autoSubmitted, ['no'])) return true;

    const precedence = get('precedence');
    if (hasToken(precedence, ['bulk', 'list', 'junk', 'auto_reply'])) return true;

    if (get('x-loop') || get('x-autoreply') || get('x-autorespond')) return true;

    // Self-from: never react to mail we ourselves sent. MAIL_FROM is usually a display
    // form like `Name <addr>` — compare the bare address, not the whole string. Also match
    // any configured queue address (seeded into ownAddresses at init).
    const ownAddr = this.extractAddress(this.config.TELECOM_HD_MAIL_FROM ?? '');
    if (ownAddr && fromEmail.toLowerCase() === ownAddr) return true;
    const normalizedFrom = normalizeEmail(fromEmail);
    if (normalizedFrom && this.ownAddresses.has(normalizedFrom)) return true;

    return false;
  }

  /** Extract the bare lowercased email address from a `Name <addr>` / `addr` string. */
  private extractAddress(value: string): string {
    const angle = /<([^>]+)>/.exec(value);
    return (angle?.[1] ?? value).trim().toLowerCase();
  }

  // ─────────────────── security helpers (parse bounds / authorization) ───────────────────

  /** Run `work` while holding one of MAX_CONCURRENT_PARSERS parse permits. */
  private async withParserSlot<T>(work: () => Promise<T>): Promise<T> {
    await this.acquireParserSlot();
    try {
      return await work();
    } finally {
      this.releaseParserSlot();
    }
  }

  private async acquireParserSlot(): Promise<void> {
    if (this.activeParsers < MAX_CONCURRENT_PARSERS) {
      this.activeParsers += 1;
      return;
    }
    if (this.parserWaiters.length >= MAX_QUEUED_PARSERS) {
      throw new ServiceUnavailableException('Inbound parser is at capacity');
    }
    // The active counter represents permits. releaseParserSlot() transfers the permit
    // directly to the oldest waiter without decrementing it first.
    await new Promise<void>((resolve, reject) => this.parserWaiters.push({ resolve, reject }));
  }

  private releaseParserSlot(): void {
    const waiter = this.parserWaiters.shift();
    if (waiter) {
      waiter.resolve();
      return;
    }
    this.activeParsers = Math.max(0, this.activeParsers - 1);
  }

  /** Reject parser-amplified fields before they reach routing, storage or regex rules. */
  private validateParsedMail(parsed: ParsedMail): void {
    this.assertFieldLength(parsed.subject, MAX_SUBJECT_CHARS, 'Subject');
    this.assertFieldLength(parsed.text, MAX_BODY_CHARS, 'Text body');
    if (typeof parsed.html === 'string') {
      this.assertFieldLength(parsed.html, MAX_BODY_CHARS, 'HTML body');
    }

    const from = this.addressEntries(parsed.from);
    if (from.length !== 1) {
      throw new BadRequestException('Inbound message must contain exactly one From address');
    }
    const allAddresses = [parsed.from, parsed.to, parsed.cc, parsed.bcc, parsed.replyTo].flatMap((field) =>
      this.addressEntries(field),
    );
    if (allAddresses.length > MAX_ADDRESSES) {
      throw new BadRequestException('Inbound message contains too many addresses');
    }
    for (const entry of allAddresses) {
      this.assertFieldLength(entry.address, MAX_ADDRESS_CHARS, 'Email address');
      this.assertFieldLength(entry.name, MAX_NAME_CHARS, 'Address display name');
    }

    // Message-ID has deliberately stricter handling than the reply/reference headers:
    // mailparser may synthesize angle brackets around a malformed raw value, and an empty
    // raw header is represented as `undefined`. resolveRealMessageId() checks the original
    // header line, so a *present* invalid Message-ID quarantines rather than falling through
    // to headerless transport deduplication.
    this.resolveRealMessageId(parsed);
    this.assertValidMessageId(parsed.inReplyTo, 'In-Reply-To');
    const references = this.referenceValues(parsed.references);
    if (references.length > MAX_REFERENCES) {
      throw new BadRequestException('Inbound message contains too many References');
    }
    const referenceChars = references.reduce((total, value) => total + value.length, 0);
    if (referenceChars > MAX_REFERENCE_CHARS) {
      throw new BadRequestException('Inbound References header is too large');
    }
    for (const reference of references) this.assertValidMessageId(reference, 'References');

    if (parsed.attachments.length > MAX_ATTACHMENTS) {
      throw new BadRequestException('Inbound message contains too many attachments');
    }
    for (const attachment of parsed.attachments) {
      this.assertFieldLength(attachment.filename, MAX_FILENAME_CHARS, 'Attachment filename');
      if (attachment.filename?.includes('\0')) {
        throw new BadRequestException('Attachment filename contains an invalid character');
      }
      this.assertFieldLength(attachment.contentType, MAX_ADDRESS_CHARS, 'Attachment content type');
    }
  }

  private addressEntries(
    field: AddressObject | AddressObject[] | undefined,
  ): Array<{ address?: string; name?: string }> {
    const objects = !field ? [] : Array.isArray(field) ? field : [field];
    return objects.flatMap((entry) =>
      Array.isArray(entry.value)
        ? entry.value.map((value) => ({ address: value.address, name: value.name }))
        : [],
    );
  }

  private referenceValues(value: ParsedMail['references']): string[] {
    if (!value) return [];
    return (Array.isArray(value) ? value : value.split(/\s+/)).filter(Boolean);
  }

  private assertFieldLength(value: string | undefined, maxChars: number, label: string): void {
    if (value !== undefined && value.length > maxChars) {
      throw new BadRequestException(`${label} exceeds the configured character limit`);
    }
  }

  private assertValidMessageId(value: unknown, label: string): void {
    if (value === undefined || value === null || value === '') return;
    if (!this.normalizeMessageId(value)) {
      throw new BadRequestException(`${label} is invalid or too long`);
    }
  }

  /**
   * Return a normalized real Message-ID, or undefined only when the header is absent.
   *
   * `mailparser` normalizes an unbracketed `Message-ID: broken` to `<broken>`, and omits an
   * empty `Message-ID:` from `headers` entirely. Looking solely at `parsed.messageId` would
   * therefore silently classify attacker/broken-sender input as either a valid ID or a
   * headerless message. The raw header line is the authoritative presence check.
   */
  private resolveRealMessageId(parsed: ParsedMail): string | undefined {
    const messageIdLines = parsed.headerLines.filter((line) => line.key.toLowerCase() === 'message-id');
    if (messageIdLines.length === 0) {
      if (parsed.messageId === undefined || parsed.messageId === null || parsed.messageId === '')
        return undefined;
      const normalized = this.normalizeMessageId(parsed.messageId);
      if (!normalized) throw new BadRequestException('Message-ID is invalid or too long');
      return normalized;
    }
    if (messageIdLines.length !== 1) {
      throw new BadRequestException('Inbound message contains multiple Message-ID headers');
    }

    const rawLine = messageIdLines[0]!.line;
    const separator = rawLine.indexOf(':');
    if (separator < 0) throw new BadRequestException('Message-ID is invalid or too long');
    // Unfold legal RFC header folding, then validate the actual header value. Whitespace inside
    // the ID itself remains invalid in normalizeMessageId().
    const rawValue = rawLine
      .slice(separator + 1)
      .replace(/\r?\n[\t ]+/g, '')
      .trim();
    const normalized = this.normalizeMessageId(rawValue);
    if (!normalized) throw new BadRequestException('Message-ID is invalid or too long');
    return normalized;
  }

  /**
   * Normalize a real RFC Message-ID for its bounded SHA-256 claim key. Invalid/oversized
   * headers are rejected by validateParsedMail and therefore quarantined; they are never
   * silently downgraded into headerless mail.
   */
  private normalizeMessageId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (
      !normalized ||
      normalized.length > MAX_MESSAGE_ID_CHARS ||
      !normalized.startsWith('<') ||
      !normalized.endsWith('>') ||
      normalized.length < 3
    ) {
      return undefined;
    }
    const body = normalized.slice(1, -1);
    for (const char of body) {
      const code = char.charCodeAt(0);
      if (code <= 0x20 || code === 0x7f || char === '<' || char === '>') return undefined;
    }
    return normalized;
  }

  private isPlausibleEmail(value: string): boolean {
    if (!value || value.length > MAX_ADDRESS_CHARS) return false;
    const at = value.indexOf('@');
    if (at <= 0 || at !== value.lastIndexOf('@') || at > 64 || at === value.length - 1) return false;
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (
      local.startsWith('.') ||
      local.endsWith('.') ||
      local.includes('..') ||
      !/^[a-z0-9!#$%&'*+\-/=?^_`{|}~.]+$/i.test(local) ||
      domain.length > 253
    ) {
      return false;
    }
    const labels = domain.split('.');
    return labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        !label.startsWith('-') &&
        !label.endsWith('-') &&
        /^[a-z0-9-]+$/i.test(label),
    );
  }

  private normalizeConfiguredMailbox(value: string): string {
    const start = value.lastIndexOf('<');
    const end = value.indexOf('>', start + 1);
    return normalizeEmail(start >= 0 && end > start ? value.slice(start + 1, end) : value);
  }

  /** A sender may reply to a ticket only if they are the requester, the linked user
   *  account, or a listed recipient — a guessed mask / leaked Message-ID is not enough. */
  private senderCanReply(ticket: ThreadableTicket, fromEmail: string): boolean {
    const sender = normalizeEmail(fromEmail);
    if (!sender) return false;
    const authorized = [
      ticket.requesterEmail,
      ...(ticket.user?.emails.map((entry) => entry.email) ?? []),
      ...(ticket.recipients?.map((recipient) => recipient.email) ?? []),
    ];
    return authorized.some((email) => Boolean(email) && normalizeEmail(email ?? '') === sender);
  }

  /** Deterministic input failures (malformed / oversized MIME) — retrying cannot help, so
   *  quarantine at once (raw MIME retained). */
  private isPermanentProcessingError(err: unknown): boolean {
    return err instanceof BadRequestException || err instanceof PayloadTooLargeException;
  }

  /**
   * `lastError` is shown in the operator UI and must never persist raw parser, database,
   * mailbox, filesystem, or provider details. Keep the durable message actionable but
   * deliberately coarse; the structured state/audit trail identifies the recovery action.
   */
  private safeProcessingError(err: unknown): string {
    if (err instanceof SemanticMessageIdConflictError) {
      return 'Message-ID conflicts with a different logical message; operator review required';
    }
    if (err instanceof PayloadTooLargeException) {
      return 'Inbound message exceeds the configured size limit';
    }
    if (err instanceof BadRequestException) {
      return 'Inbound message was rejected by validation';
    }
    if (err instanceof ServiceUnavailableException) {
      return 'Inbound dependency is temporarily unavailable';
    }
    return 'Inbound processing failed; retry scheduled';
  }

  // ─────────────────── parser rules (unchanged) ───────────────────

  /**
   * Apply enabled PRE_PARSE parser rules to a parsed inbound email.
   * Rules are evaluated in sortOrder ascending.
   * Returns overrides to apply when creating the ticket, or skip=true to discard.
   */
  async applyParserRules(parsed: ParsedEmail, _deptId: number | undefined): Promise<ParserRuleResult> {
    const result: ParserRuleResult = { skip: false, tags: [] };

    let rules: EmailParserRule[];
    try {
      rules = await this.prisma.emailParserRule.findMany({
        where: { isEnabled: true, ruleType: 'PRE_PARSE' },
        orderBy: { sortOrder: 'asc' },
      });
    } catch (err) {
      // Table not migrated yet → skip rules gracefully. But a REAL DB error must NOT be
      // swallowed (that would silently route mail to the default department); rethrow so
      // the delivery goes to RETRY instead.
      if (/does not exist/i.test(String(err))) return result;
      throw err;
    }

    for (const rule of rules) {
      const criteria = (Array.isArray(rule.criteria) ? rule.criteria : []) as Array<{
        field: string;
        op: string;
        value: string;
      }>;
      const actions = (Array.isArray(rule.actions) ? rule.actions : []) as Array<{
        type: string;
        value?: string | number;
      }>;

      const matches = this.evaluateCriteria(parsed, criteria, rule.matchType);
      if (!matches) continue;

      for (const action of actions) {
        switch (action.type) {
          case 'ignore':
            result.skip = true;
            break;
          case 'route_dept':
            if (action.value !== undefined) result.departmentId = Number(action.value);
            break;
          case 'set_priority':
            if (action.value !== undefined) result.priorityId = Number(action.value);
            break;
          case 'assign_staff':
            if (action.value !== undefined) result.ownerStaffId = Number(action.value);
            break;
          case 'add_tag':
            if (typeof action.value === 'string' && action.value) result.tags.push(action.value);
            break;
        }
      }

      if (rule.stopProcessing) break;
    }

    return result;
  }

  /**
   * Evaluate a set of criteria against a parsed email.
   * matchType=ALL: all criteria must match. matchType=ANY: at least one must match.
   */
  evaluateCriteria(
    parsed: ParsedEmail,
    criteria: Array<{ field: string; op: string; value: string }>,
    matchType: string,
  ): boolean {
    if (criteria.length === 0) return true;
    const results = criteria.map((c) => this.matchCriterion(parsed, c));
    return matchType === 'ANY' ? results.some(Boolean) : results.every(Boolean);
  }

  private matchCriterion(parsed: ParsedEmail, c: { field: string; op: string; value: string }): boolean {
    const fieldVal = this.extractField(parsed, c.field);
    const target = c.value ?? '';

    switch (c.op) {
      case 'eq':
        return fieldVal.toLowerCase() === target.toLowerCase();
      case 'contains':
        return fieldVal.toLowerCase().includes(target.toLowerCase());
      case 'not_contains':
        return !fieldVal.toLowerCase().includes(target.toLowerCase());
      case 'starts_with':
        return fieldVal.toLowerCase().startsWith(target.toLowerCase());
      case 'ends_with':
        return fieldVal.toLowerCase().endsWith(target.toLowerCase());
      case 'regex': {
        // JavaScript RegExp has no execution timeout, so a catastrophic-backtracking pattern
        // in a DB parser rule + an attacker-controlled inbound body would block the event
        // loop (full-API DoS). Only run patterns from a safe, linear-time subset.
        if (!this.isSafeRuleRegex(target)) return false;
        try {
          return new RegExp(target, 'i').test(fieldVal);
        } catch {
          return false;
        }
      }
      default:
        return false;
    }
  }

  /**
   * Accept only a small, linear-time regex subset for DB parser rules: bounded length, no
   * groups/alternation/`{}` quantifiers, at most one simple quantifier, no backreferences or
   * Unicode-property escapes, and an unbounded `*`/`+` only when start-anchored. Prevents
   * ReDoS from a privileged-but-easily-mistaken rule pattern. (Preserved from main.)
   */
  private isSafeRuleRegex(pattern: string): boolean {
    if (!pattern || pattern.length > MAX_RULE_PATTERN_CHARS) return false;
    let escaped = false;
    let inClass = false;
    let classHasCharacter = false;
    let canQuantify = false;
    let quantifiers = 0;
    let hasUnboundedQuantifier = false;

    for (let i = 0; i < pattern.length; i += 1) {
      const char = pattern[i]!;
      if (escaped) {
        if (/\d/.test(char) || char === 'k' || char === 'p' || char === 'P') return false;
        escaped = false;
        if (inClass) classHasCharacter = true;
        else canQuantify = true;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (inClass) {
        if (char === ']') {
          if (!classHasCharacter) return false;
          inClass = false;
          canQuantify = true;
        } else {
          classHasCharacter = true;
        }
        continue;
      }
      if (char === '[') {
        inClass = true;
        classHasCharacter = false;
        canQuantify = false;
        continue;
      }
      if ('()|{}'.includes(char)) return false;
      if (char === '*' || char === '+' || char === '?') {
        if (!canQuantify || quantifiers >= 1) return false;
        quantifiers += 1;
        if (char === '*' || char === '+') hasUnboundedQuantifier = true;
        canQuantify = false;
        continue;
      }
      if (char === '^' || char === '$') {
        canQuantify = false;
        continue;
      }
      canQuantify = true;
    }

    return !escaped && !inClass && (!hasUnboundedQuantifier || pattern.startsWith('^'));
  }

  private extractField(parsed: ParsedEmail, field: string): string {
    switch (field) {
      case 'subject':
        return parsed.subject;
      case 'sender':
        return parsed.fromEmail;
      case 'sendername':
        return parsed.fromName;
      case 'recipient':
        return parsed.toEmail ?? '';
      case 'body':
        return parsed.body;
      default:
        return '';
    }
  }

  /** Keep IMAP/auth exceptions out of logs; their messages may contain connection secrets. */
  private errorKind(err: unknown): string {
    return err instanceof Error && err.name ? err.name.slice(0, 80) : 'UnknownError';
  }

  private async defaultDeptId(): Promise<number> {
    const dept = await this.prisma.department.findFirst({ where: { isDefault: true } });
    return dept?.id ?? 1;
  }
}
