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
import type { EmailParserRule } from '@prisma/client';
import { normalizePipeDeliveryId } from './pipe-input.util';
import { InboundRawStorageService } from './inbound-raw-storage.service';

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
  /** Fingerprint (host/port/tls/user/password) of each live connection so the supervisor
   *  reconnects when a queue's credentials or host change, not only when it drops. */
  private readonly connectionFingerprints = new Map<number, string>();
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

  private get maxAttempts(): number {
    return this.config.TELECOM_HD_INBOUND_MAX_ATTEMPTS;
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
    // Seed loop-suppression addresses (our MAIL_FROM + every enabled queue) BEFORE the
    // TELECOM_HD_IMAP_ENABLED early-return, so a self-loop is suppressed even when the
    // poller is disabled and mail arrives only via the PIPE webhook. The set is rebuilt on
    // every supervisor cycle (reconcileConnections) so a queue address change is reflected.
    await this.refreshOwnAddresses();
    this.ownAddressHandle = setInterval(() => {
      void this.refreshOwnAddresses();
    }, 60_000);
    this.ownAddressHandle.unref?.();

    // A1: surface enabled queues whose transport we don't poll (e.g. PIPE) instead of
    // silently ignoring them — their mail is fed via POST /api/inbound/pipe.
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

    // The drain runs regardless of IMAP so PIPE RETRY deliveries always make progress.
    // Kick once now so any deliveries left PROCESSING by a previous crash are reclaimed
    // as soon as their lease expires (startup recovery), then every 30 s.
    this.drainHandle = setInterval(() => {
      void this.drainDeliveries().catch((err: unknown) =>
        this.logger.error(`Inbound drain error: ${String(err)}`),
      );
    }, 30_000);
    void this.drainDeliveries().catch((err: unknown) =>
      this.logger.error(`Inbound startup drain error: ${String(err)}`),
    );

    // Raw-MIME retention: prune terminal deliveries' inline blobs hourly (and once now) so the
    // ledger's on-disk footprint stays bounded. Independent of IMAP (PIPE deliveries too).
    this.pruneHandle = setInterval(() => {
      void this.pruneRawMime().catch((err: unknown) =>
        this.logger.error(`Inbound retention prune error: ${String(err)}`),
      );
    }, 60 * 60_000);
    this.pruneHandle.unref?.();
    void this.pruneRawMime().catch((err: unknown) =>
      this.logger.error(`Inbound startup retention prune error: ${String(err)}`),
    );

    if (!this.config.TELECOM_HD_IMAP_ENABLED) {
      this.logger.log('IMAP polling disabled (TELECOM_HD_IMAP_ENABLED=false) — drain active for PIPE');
      return;
    }

    const queues = await this.prisma.emailQueue.findMany({
      where: { isEnabled: true, type: 'IMAP' },
    });

    // Connect any queues that exist now. Do NOT early-return when there are zero — the
    // poll supervisor below (reconcileConnections, run each cycle) connects queues created
    // or enabled AFTER startup, so a first IMAP queue added at runtime is polled without an
    // API restart (previously a zero-queue boot left the supervisor unstarted forever).
    const encKey = this.config.TELECOM_HD_FIELD_ENCRYPTION_KEY;
    for (const queue of queues) {
      let plainPassword: string;
      try {
        plainPassword = decryptField(queue.passwordEnc, encKey);
      } catch (err) {
        this.logger.error(`Failed to decrypt IMAP password for queue ${queue.id}: ${String(err)}`);
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
      void this.pollNow().catch((err: unknown) => this.logger.error(`IMAP poll error: ${String(err)}`));
    }, 60_000);

    this.logger.log(
      `IMAP inbound polling supervisor started (${queues.length} queue(s) connected at boot; ` +
        `reconnects + newly enabled queues handled each cycle)`,
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
      this.logger.error(`ownAddresses refresh failed (keeping prior set): ${String(err)}`);
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
      this.logger.warn(`Inbound poll shutdown wait failed: ${String(err)}`),
    );
    await this.drainInFlight?.catch((err: unknown) =>
      this.logger.warn(`Inbound drain shutdown wait failed: ${String(err)}`),
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
  }

  // ─────────────────── connection + bootstrap ───────────────────

  private async connectQueue(
    queueId: number,
    opts: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } },
  ): Promise<void> {
    if (this.stopping) return;
    await this.stampQueue(queueId, { lastConnectionAttemptAt: new Date() });
    try {
      const { ImapFlow: ImapFlowCtor } = await import('imapflow');
      const client = new ImapFlowCtor({
        host: opts.host,
        port: opts.port,
        secure: opts.secure,
        auth: opts.auth,
        logger: false,
      });
      await client.connect();
      this.connections.set(queueId, client);
      await this.stampQueue(queueId, { lastConnectedAt: new Date() });
      this.logger.log(`IMAP connected to queue ${queueId} (${opts.host}:${opts.port})`);
      // Capture the baseline SYNCHRONOUSLY at activation (not on the first 60s poll) so
      // mail arriving between connect and the first poll is not skipped (P0-2).
      await this.bootstrapQueue(queueId, client);
    } catch (err) {
      this.logger.error(`Failed to connect IMAP queue ${queueId}: ${String(err)}`);
      await this.stampQueue(queueId, {
        lastConnectionErrorAt: new Date(),
        lastDisconnectedAt: new Date(),
        // Do not persist a potentially credential-bearing driver error. Operators get a
        // stable, safe summary while the structured application log keeps diagnostics.
        lastError: 'IMAP connection failed; verify queue configuration and server availability',
      });
    }
  }

  /**
   * Record the starting cursor for a never-bootstrapped queue (uidValidity IS NULL).
   * FROM_NOW records the current high-water UID and imports nothing; BACKFILL rewinds
   * the cursor by up to TELECOM_HD_IMAP_BACKFILL_LIMIT so the most-recent existing
   * messages are ingested. Never fails open to `1:*`.
   */
  private async bootstrapQueue(queueId: number, client: ImapFlow): Promise<void> {
    const queue = await this.prisma.emailQueue.findUnique({ where: { id: queueId } });
    if (!queue || queue.uidValidity !== null) return; // already bootstrapped
    if (queue.syncState === 'NEEDS_RECONCILIATION') {
      // Halted (e.g. upgraded from a legacy cursor) — never auto-FROM_NOW over it; an
      // operator must reconcile explicitly (choose FROM_NOW or a bounded BACKFILL).
      this.logger.warn(
        `IMAP queue ${queueId}: NEEDS_RECONCILIATION — bootstrap skipped (operator action required)`,
      );
      return;
    }
    const lock = await client.getMailboxLock('INBOX');
    try {
      const { uidValidity, uidNext, exists } = this.readMailboxState(client);
      if (uidValidity === undefined) {
        this.logger.warn(`IMAP queue ${queueId}: server did not advertise UIDVALIDITY — bootstrap deferred`);
        return;
      }
      const highWater = await this.resolveHighWaterUid(client, uidNext, exists);
      if (highWater === null) {
        this.logger.warn(`IMAP queue ${queueId}: cannot resolve high-water UID — bootstrap deferred`);
        return;
      }
      // A per-queue reconcile intent (bootstrapPolicy) overrides the global policy for
      // THIS bootstrap so the mode an operator chose at reconcile time is honoured.
      const policy = queue.bootstrapPolicy ?? this.config.TELECOM_HD_IMAP_BOOTSTRAP_POLICY;
      const backfill =
        policy === 'BACKFILL'
          ? (queue.bootstrapBackfillLimit ?? this.config.TELECOM_HD_IMAP_BACKFILL_LIMIT)
          : 0;
      const baseline = Math.max(highWater - backfill, 0);
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
          uidValidity: null,
          cursorGeneration: queue.cursorGeneration,
          syncState: { in: ['OK', 'BOOTSTRAPPING'] },
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
          `(highWater=${highWater}, uidValidity=${uidValidity})`,
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
    await this.reconcileConnections();
    for (const [queueId, client] of this.connections) {
      try {
        await this.pollQueue(queueId, client);
      } catch (err) {
        this.logger.error(`IMAP poll failed for queue ${queueId}: ${String(err)}`);
      }
      // Drop an unusable (dropped) connection so reconcileConnections reconnects it.
      if ((client as { usable?: boolean }).usable === false) {
        this.connections.delete(queueId);
        this.connectionFingerprints.delete(queueId);
        await this.stampQueue(queueId, { lastDisconnectedAt: new Date() });
        this.logger.warn(`IMAP queue ${queueId}: connection dropped — will reconnect next cycle`);
      }
    }
    await this.drainDeliveries();
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
    if (!this.config.TELECOM_HD_IMAP_ENABLED || this.stopping) return;
    let enabled: Array<{
      id: number;
      emailAddress: string;
      host: string;
      port: number;
      useTls: boolean;
      username: string;
      passwordEnc: string;
    }>;
    try {
      enabled = await this.prisma.emailQueue.findMany({
        where: { isEnabled: true, type: 'IMAP' },
        select: {
          id: true,
          emailAddress: true,
          host: true,
          port: true,
          useTls: true,
          username: true,
          passwordEnc: true,
        },
      });
    } catch (err) {
      this.logger.error(`IMAP reconcile query failed: ${String(err)}`);
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
        await this.stampQueue(queueId, { lastDisconnectedAt: new Date() });
        this.logger.log(`IMAP queue ${queueId}: disabled/removed — disconnected`);
      }
    }

    // Connect enabled queues with no live connection, and RECONNECT ones whose
    // host/credentials changed (a stale connection would keep polling the old server).
    const encKey = this.config.TELECOM_HD_FIELD_ENCRYPTION_KEY;
    for (const q of enabled) {
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
        await this.stampQueue(q.id, { lastDisconnectedAt: new Date() });
        this.logger.log(`IMAP queue ${q.id}: connection settings changed — reconnecting`);
      }
      let plainPassword: string;
      try {
        plainPassword = decryptField(q.passwordEnc, encKey);
      } catch (err) {
        this.logger.error(`Failed to decrypt IMAP password for queue ${q.id}: ${String(err)}`);
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

  /** Stable fingerprint of a queue's connection settings (drives reconnect-on-change). */
  private connectionFingerprint(q: {
    host: string;
    port: number;
    useTls: boolean;
    username: string;
    passwordEnc: string;
  }): string {
    return createHash('sha256')
      .update(`${q.host}\u0000${q.port}\u0000${q.useTls}\u0000${q.username}\u0000${q.passwordEnc}`)
      .digest('hex');
  }

  private async pollQueue(queueId: number, client: ImapFlow): Promise<void> {
    if (this.stopping || this.pollingQueues.has(queueId)) return;
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
    const queue = await this.prisma.emailQueue.findUnique({ where: { id: queueId } });
    if (!queue || !queue.isEnabled) return;

    if (queue.syncState === 'NEEDS_RECONCILIATION') {
      if (!this.haltLogged.has(queueId)) {
        this.logger.error(
          `IMAP queue ${queueId} halted (NEEDS_RECONCILIATION): ${queue.lastError ?? 'UIDVALIDITY change'} — ` +
            `operator must choose FROM_NOW or a bounded BACKFILL (clear uidValidity to re-bootstrap).`,
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
      const lock = await client.getMailboxLock('INBOX');
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
          await this.prisma.emailQueue.updateMany({
            where: {
              id: queueId,
              cursorGeneration: queue.cursorGeneration,
              uidValidity: queue.uidValidity,
            },
            data: { syncState: 'NEEDS_RECONCILIATION', lastError: msg },
          });
          this.logger.error(`IMAP queue ${queueId}: ${msg} — queue halted (NEEDS_RECONCILIATION)`);
          return;
        }

        // Cursor is a BigInt column (IMAP UIDs are unsigned 32-bit). UID values are well
        // within 2^53, so we compute in Number and store back as BigInt.
        const lastUid = Number(queue.lastSeenUid);
        // Discover new UIDs first (uid-only), then fetch+accept each in ascending order
        // so out-of-order server responses can't make the cursor leapfrog a gap.
        const uids: number[] = [];
        for await (const m of client.fetch(`${lastUid + 1}:*`, { uid: true }, { uid: true })) {
          if (typeof m.uid === 'number' && m.uid > lastUid) uids.push(m.uid);
        }
        uids.sort((a, b) => a - b);

        let cursor = lastUid;
        let acceptedAny = false;
        for (const uid of uids) {
          try {
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
              cursor = uid;
              continue;
            }
            await this.acceptImapMessage(queueId, queue.departmentId ?? null, uidValidity, uid, msg.source);
            acceptedAny = true;
            cursor = uid; // advance ONLY after durable acceptance
          } catch (err) {
            // Fetch or DB failure → FAIL-CLOSED: stop without advancing past this UID.
            this.logger.error(`IMAP queue ${queueId}: accept failed at uid=${uid} — ${String(err)}`);
            break;
          }
        }

        if (cursor > lastUid) {
          // Monotonic, generation-guarded CAS: advance only if nothing reconciled the
          // queue underneath us (same cursorGeneration + uidValidity, still OK+enabled).
          // A stale poller that finishes after a reconcile writes 0 rows — it can't push
          // a cursor from the old UID space into the new one.
          const cas = await this.prisma.emailQueue.updateMany({
            where: {
              id: queueId,
              lastSeenUid: { lt: BigInt(cursor) },
              cursorGeneration: queue.cursorGeneration,
              uidValidity: queue.uidValidity,
              syncState: 'OK',
              isEnabled: true,
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
          ...(acceptedAny ? { lastAcceptedAt: new Date() } : {}),
        });
      } finally {
        lock.release();
      }
    }

    await this.drainDeliveries();
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
        this.logger.warn(`Inbound raw storage cleanup failed for delivery ${row.id}: ${String(err)}`);
      }
    }
  }

  /**
   * Clean at most 100 stale pre-commit markers per retention pass. A marker is created before
   * the raw file and removed after the ledger row is inserted. We only remove a marker/file
   * after a database lookup proves no delivery points at it; a surviving referenced marker is
   * simply committed, making crash recovery idempotent and safe for quarantined evidence.
   */
  private async cleanupUncommittedRawStorage(): Promise<void> {
    if (!this.rawStorage) return;
    const olderThan = new Date(Date.now() - 15 * 60_000);
    let candidates: string[];
    try {
      candidates = await this.rawStorage.listPending(100, olderThan);
    } catch (err) {
      this.logger.warn(`Inbound raw storage marker scan failed: ${String(err)}`);
      return;
    }
    if (candidates.length === 0) return;

    try {
      const references = await this.prisma.inboundDelivery.findMany({
        where: { rawStorageKey: { in: candidates } },
        select: { rawStorageKey: true },
      });
      const referenced = new Set(
        references.map((row) => row.rawStorageKey).filter((key): key is string => key !== null),
      );
      for (const key of candidates) {
        try {
          if (referenced.has(key)) {
            await this.rawStorage.commit(key);
          } else {
            await this.rawStorage.remove(key);
          }
        } catch (err) {
          this.logger.warn(`Inbound raw storage marker cleanup failed for ${key}: ${String(err)}`);
        }
      }
    } catch (err) {
      // A failed DB proof must never delete a file: leave the marker for the next bounded pass.
      this.logger.warn(`Inbound raw storage marker cleanup deferred (DB unavailable): ${String(err)}`);
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
      lastError?: string;
    },
  ): Promise<void> {
    try {
      await this.prisma.emailQueue.updateMany({ where: { id: queueId }, data });
    } catch (err) {
      this.logger.warn(`IMAP queue ${queueId}: liveness stamp failed — ${String(err)}`);
    }
  }

  /**
   * Durably record one IMAP message in the ledger under its unique transport key.
   * Idempotent: a duplicate key (re-poll / concurrent poller) is a no-op. The message
   * is NOT parsed here — a malformed MIME is still ACCEPTED (never lost) and is
   * quarantined later by the drain if it cannot be processed.
   */
  private async acceptImapMessage(
    queueId: number,
    departmentId: number | null,
    uidValidity: bigint,
    uid: number,
    source: Buffer,
  ): Promise<void> {
    const transportKey = `imap:${queueId}:${uidValidity}:${uid}`;
    const contentHash = createHash('sha256').update(source).digest('hex');
    // The IMAP fetch caps the body at MAX_SIZE+1 bytes; a source at/over the ceiling was
    // TRUNCATED — its retained raw MIME is incomplete, so flag it (the drain quarantines a
    // truncated delivery without partially ticketing it; replay must re-fetch the original).
    const truncated = source.length > this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024;
    const raw = await this.persistRawMime(source);
    try {
      await this.prisma.inboundDelivery.create({
        data: {
          transport: 'IMAP',
          queueId,
          departmentId, // snapshot at acceptance
          transportKey,
          uidValidity,
          uid: BigInt(uid),
          contentHash,
          rawMime: raw.rawMime,
          rawStorageKey: raw.rawStorageKey,
          sizeBytes: source.length,
          truncated,
          state: 'ACCEPTED',
        },
      });
      if (raw.rawStorageKey && this.rawStorage) {
        await this.rawStorage
          .commit(raw.rawStorageKey)
          .catch((err: unknown) =>
            this.logger.warn(`Inbound raw MIME marker commit failed for IMAP delivery: ${String(err)}`),
          );
      }
    } catch (err) {
      // A transport retry did not consume the freshly-staged external copy.
      if (raw.rawStorageKey && this.rawStorage) {
        await this.rawStorage.remove(raw.rawStorageKey).catch(() => undefined);
      }
      if (this.isUniqueViolation(err)) return; // already accepted — idempotent
      throw err;
    }
  }

  // ─────────────────── PIPE ingress ───────────────────

  /**
   * Public entry for the MTA/PIPE webhook. Records the message in the ledger (idempotent
   * by a trusted caller-supplied delivery id) and processes it inline so the
   * caller sees the ticket immediately; a transient failure leaves a RETRY the drain
   * picks up. Signature kept `(source, departmentId)` for the webhook controller.
   */
  async ingestRawMessage(
    source: Buffer | string,
    departmentId: number | undefined,
    externalId?: string,
    queueId?: number,
  ): Promise<void> {
    const buf = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    if (buf.length > this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024) {
      throw new PayloadTooLargeException('Inbound message exceeds the configured size limit');
    }

    // PIPE has no safe default queue: accepting a request against an unknown/disabled/IMAP
    // queue would turn routing into a silent fallback. Snapshot the active PIPE queue's
    // department at acceptance so later configuration edits cannot reroute this delivery.
    if (queueId == null) throw new BadRequestException('x-inbound-queue-id is required for PIPE ingress');
    const normalizedExternalId = normalizePipeDeliveryId(externalId);
    const q = await this.prisma.emailQueue.findUnique({
      where: { id: queueId },
      select: { id: true, emailAddress: true, departmentId: true, type: true, isEnabled: true },
    });
    if (!q) throw new BadRequestException(`Unknown inbound queue id ${queueId}`);
    if (!q.isEnabled) throw new BadRequestException(`Inbound PIPE queue ${queueId} is disabled`);
    if (q.type !== 'PIPE') {
      throw new BadRequestException(`Inbound queue ${queueId} must have type PIPE (got ${q.type})`);
    }
    const boundQueueId = q.id;
    // The webhook never trusts a caller-provided department. An internal caller may only
    // supply the same snapshot; otherwise fail closed rather than misroute a ticket.
    if (departmentId !== undefined && departmentId !== q.departmentId) {
      throw new BadRequestException('PIPE department must match the bound queue');
    }
    const deptForDelivery = q.departmentId ?? null;

    const contentHash = createHash('sha256').update(buf).digest('hex');
    // Index a fixed-width SHA-256 of the normalized MTA id rather than an arbitrary
    // header value. Keep the original normalized id for diagnostics/audit.
    const deliveryIdHash = createHash('sha256').update(normalizedExternalId).digest('hex');
    const transportKey = `pipe:${boundQueueId}:id-sha256:${deliveryIdHash}`;

    const raw = await this.persistRawMime(buf);
    let deliveryId: number | null = null;
    try {
      const created = await this.prisma.inboundDelivery.create({
        data: {
          transport: 'PIPE',
          queueId: boundQueueId,
          departmentId: deptForDelivery,
          transportKey,
          externalId: normalizedExternalId,
          contentHash,
          // The MTA already chose this enabled PIPE queue. Preserve that trusted envelope
          // recipient independently of any MIME `To` header, which may be absent/BCC-only or
          // caller-controlled and is needed later for deterministic routing.
          envelopeTo: q.emailAddress,
          rawMime: raw.rawMime,
          rawStorageKey: raw.rawStorageKey,
          sizeBytes: buf.length,
          state: 'ACCEPTED',
        },
        select: { id: true },
      });
      deliveryId = created.id;
      if (raw.rawStorageKey && this.rawStorage) {
        await this.rawStorage
          .commit(raw.rawStorageKey)
          .catch((err: unknown) =>
            this.logger.warn(`Inbound raw MIME marker commit failed for PIPE delivery: ${String(err)}`),
          );
      }
    } catch (err) {
      if (raw.rawStorageKey && this.rawStorage) {
        await this.rawStorage.remove(raw.rawStorageKey).catch(() => undefined);
      }
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
    await this.processDelivery(deliveryId, deptForDelivery ?? undefined);
  }

  // ─────────────────── drain (process ledger) ───────────────────

  /**
   * Process due deliveries in id order: fresh `ACCEPTED`/`RETRY` work, plus any
   * `PROCESSING` whose lease has expired (a worker crashed mid-processing) — so a
   * delivery can never be stranded in `PROCESSING` forever.
   */
  drainDeliveries(): Promise<void> {
    if (this.stopping) return this.drainInFlight ?? Promise.resolve();
    if (this.drainInFlight) return this.drainInFlight;

    const cycle = this.runDrainDeliveries().finally(() => {
      if (this.drainInFlight === cycle) this.drainInFlight = null;
    });
    this.drainInFlight = cycle;
    return cycle;
  }

  private async runDrainDeliveries(): Promise<void> {
    const now = new Date();
    let due: Array<{ id: number; departmentId: number | null }>;
    try {
      due = await this.prisma.inboundDelivery.findMany({
        where: {
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
      this.logger.error(`Inbound drain query failed: ${String(err)}`);
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
    const claim = await this.prisma.inboundDelivery.updateMany({
      where: {
        id: deliveryId,
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

    let rawMime: Buffer | null = delivery.rawMime ? Buffer.from(delivery.rawMime) : null;
    if (!rawMime && delivery.rawStorageKey) {
      rawMime = (await this.rawStorage?.read(delivery.rawStorageKey)) ?? null;
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

    // A truncated (oversized) IMAP fetch has incomplete raw bytes — never partially ticket it.
    // Quarantine at once with a clear reason; a faithful replay must re-fetch the original.
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

    // For an IMAP delivery, also dedup against the LEGACY transport Message-ID form
    // (`<imap-<queueId>-<uidValidity>-<uid>@helpdesk.invalid>`) that the pre-ledger poller
    // stamped on header-less mail — otherwise a RESUME_MIGRATED re-fetch of already-ticketed
    // header-less mail would miss dedup (it now hashes to a different synthetic id) and
    // duplicate the ticket.
    const legacyDedupIds: string[] = [];
    if (
      delivery.transport === 'IMAP' &&
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
    // Synthetic-id seed for header-less mail: a QUEUE-SCOPED CONTENT identity, not the raw
    // UID. For IMAP use `imap:<queueId>:<contentHash>` — stable across a UIDVALIDITY reset +
    // BACKFILL re-fetch (same queue+bytes → same id → deduped, no double ticket) yet distinct
    // per queue (identical bytes to two queues → two ids → both ticketed, no silent collapse).
    // For PIPE the transport key already encodes queue + the caller's externalId/content.
    const syntheticSeed =
      delivery.transport === 'IMAP'
        ? `imap:${delivery.queueId ?? '-'}:${delivery.contentHash}`
        : delivery.transportKey;
    try {
      const outcome = await this.processRawMessage(rawMime, departmentId, {
        deliveryId,
        legacyDedupIds,
        syntheticSeed,
      });
      await settle({
        state: outcome.state,
        ticketId: outcome.ticketId ?? null,
        postId: outcome.postId ?? null,
        processedAt: new Date(),
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    } catch (err) {
      const attempts = delivery.attempts; // already incremented by the claim CAS
      // A malformed / oversized message fails deterministically — quarantine it at once
      // (raw MIME retained) instead of burning every retry on an error that cannot pass.
      if (this.isPermanentProcessingError(err) || attempts >= this.maxAttempts) {
        await settle({
          state: 'QUARANTINED',
          attempts,
          lastError: String(err),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        this.logger.error(
          `Inbound delivery ${deliveryId}: QUARANTINED after ${attempts} attempt(s) (raw MIME retained for replay) — ${String(err)}`,
        );
      } else {
        const backoffMs = 60_000 * 2 ** (attempts - 1);
        await settle({
          state: 'RETRY',
          attempts,
          nextAttemptAt: new Date(Date.now() + backoffMs),
          lastError: String(err),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        this.logger.warn(
          `Inbound delivery ${deliveryId}: retry ${attempts}/${this.maxAttempts} in ${backoffMs}ms — ${String(err)}`,
        );
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Persist small raw MIME inline for low-latency ledger reads. Large MIME is staged into
   * the existing uploads volume before the ledger row is inserted; caller removes an orphan
   * if that DB insert loses a transport race or fails.
   */
  private async persistRawMime(
    source: Buffer,
  ): Promise<{ rawMime: Uint8Array<ArrayBuffer> | null; rawStorageKey: string | null }> {
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
    const rawStorageKey = await this.rawStorage.write(source);
    return { rawMime: null, rawStorageKey };
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
        `INBOUND ALERT transport collision queue=${input.queueId}: audit write failed — ${String(err)}`,
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
      legacyDedupIds?: string[];
      /** Queue-scoped CONTENT identity used to synthesize the effective Message-ID for
       *  header-less mail — stable across a re-fetch of the same message (so a BACKFILL
       *  re-import dedups) yet distinct per queue (so identical bytes to two queues are both
       *  ticketed, never silently collapsed). Falls back to the raw bytes when absent. */
      syntheticSeed?: string;
    } = {},
  ): Promise<ProcessOutcome> {
    const { deliveryId, legacyDedupIds = [], syntheticSeed } = opts;
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

    // A5(ii): drop machine-generated / looping mail before it can create a ticket/reply.
    if (this.isLoopMessage(parsed, fromEmail)) {
      this.logger.log('Inbound: skipped auto/loop message');
      return { state: 'SKIPPED' };
    }

    // Effective Message-ID: the real (normalized) RFC id, or a deterministic synthetic one
    // when the message carries none. The synthetic id is seeded from a QUEUE-SCOPED CONTENT
    // identity (`imap:<queueId>:<contentHash>` for IMAP; the transport key for PIPE), so it is
    // stable across a re-fetch of the same message (a BACKFILL after a UIDVALIDITY reset dedups
    // instead of double-ticketing) yet distinct per queue (identical bytes to two queues are
    // BOTH ticketed, never silently collapsed). Falls back to the raw bytes when no seed given.
    const rawBuf = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    const realMessageId = this.normalizeMessageId(parsed.messageId);
    const seed: string | Buffer = syntheticSeed ?? rawBuf;
    const effectiveMessageId =
      realMessageId ?? `<inbound-${createHash('sha256').update(seed).digest('hex')}@23telecom.local>`;

    // ATOMIC dedup claim (race-safe): stamp the effective Message-ID + parsed identity on THIS
    // ledger row. The unique index on `messageId` means only one delivery can own it — a
    // concurrent IMAP+PIPE (or two-poller) duplicate loses the race with P2002 and is SKIPPED,
    // instead of both check-then-act creating a ticket. A shared Message-ID (real RFC id, or a
    // same queue+content synthetic id) IS the same logical message — e.g. a message CC'd to two
    // polled mailboxes gets per-hop trace headers that differ byte-for-byte but is still ONE
    // message — so a conflict is a duplicate to SKIP, never a spoof to quarantine.
    if (deliveryId != null) {
      try {
        await this.prisma.inboundDelivery.update({
          where: { id: deliveryId },
          data: {
            messageId: effectiveMessageId,
            envelopeFrom: fromEmail,
            envelopeTo: toAddress ?? null,
            subject: subject.slice(0, 500),
          },
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          this.logger.log(`Inbound: duplicate message ${effectiveMessageId} from ${fromEmail} — skipped`);
          return { state: 'SKIPPED' };
        }
        throw err;
      }
    }

    // Secondary fast dedup: if a post already bears this Message-ID it was ingested before
    // (e.g. a retry after the post was created, or — via `legacyDedupIds` — the pre-ledger
    // poller already ticketed this exact IMAP UID). Returns the existing ids for observability.
    const dedupIds = [effectiveMessageId, ...legacyDedupIds];
    const existing = await this.prisma.ticketPost.findFirst({
      where: { messageId: { in: dedupIds } },
      select: { id: true, ticketId: true },
    });
    if (existing) {
      this.logger.log(`Inbound: duplicate message ${effectiveMessageId} from ${fromEmail} — skipped`);
      return { state: 'SKIPPED', ticketId: existing.ticketId, postId: existing.id };
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
        return { state: 'PROCESSED', ticketId: linkedPost.ticketId, postId: post.id };
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
          requesterEmail: true,
          user: { select: { emails: { select: { email: true } } } },
          recipients: { select: { email: true } },
        },
      });
      if (maskTicket && this.senderCanReply(maskTicket, fromEmail)) {
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
        return { state: 'PROCESSED', ticketId: maskTicket.id, postId: post.id };
      }
      this.logger.warn(
        maskTicket
          ? `Inbound: mask ${mask} sender not authorized — creating new ticket`
          : `Inbound: mask ${mask} did not resolve — creating new ticket`,
      );
    }

    // 3. PRE_PARSE parser rules (before creating a new ticket)
    const parsedEmail: ParsedEmail = { subject, fromEmail, fromName, toEmail: toAddress, body: textBody };
    const ruleResult = await this.applyParserRules(parsedEmail, departmentId);
    if (ruleResult.skip) {
      this.logger.log(`Inbound: message from ${fromEmail} discarded by parser rule — "${subject}"`);
      return { state: 'SKIPPED' };
    }

    // 4. Create a new ticket. Message-ID written atomically with the first post.
    const deptId = ruleResult.departmentId ?? departmentId ?? (await this.defaultDeptId());
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
      ...(ruleResult.priorityId !== undefined ? { priorityId: ruleResult.priorityId } : {}),
      ...(ruleResult.ownerStaffId !== undefined ? { ownerStaffId: ruleResult.ownerStaffId } : {}),
    });
    const firstPost = await this.prisma.ticketPost.findFirst({
      where: { ticketId: newTicket.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    this.logger.log(`Inbound: new ticket ${newTicket.mask} from ${fromEmail} — "${subject}"`);
    return { state: 'PROCESSED', ticketId: newTicket.id, postId: firstPost?.id };
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

    this.assertValidMessageId(parsed.messageId, 'Message-ID');
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

  /** Trim + reject control/space chars; bound the length. Returns undefined if invalid. */
  private normalizeMessageId(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim();
    if (!normalized || normalized.length > MAX_MESSAGE_ID_CHARS) return undefined;
    for (const char of normalized) {
      const code = char.charCodeAt(0);
      if (code <= 0x20 || code === 0x7f) return undefined;
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

  private async defaultDeptId(): Promise<number> {
    const dept = await this.prisma.department.findFirst({ where: { isDefault: true } });
    return dept?.id ?? 1;
  }
}
