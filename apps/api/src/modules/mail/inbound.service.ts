import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import type { ImapFlow } from 'imapflow';
import { TicketsService } from '../tickets/tickets.service';
import { MailService } from './mail.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptField } from '../../common/field-encrypt.util';
import { stripQuotedReply } from './quoted-reply.util';
import type { EmailParserRule } from '@prisma/client';

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
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private drainHandle: ReturnType<typeof setInterval> | null = null;
  /** Throttle repeated "queue halted" logs to once per interval per queue. */
  private readonly haltLogged = new Set<number>();
  /** This process's lease owner id — stamped on claimed deliveries. */
  private readonly instanceId = randomUUID();
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
  ) {}

  async onModuleInit(): Promise<void> {
    // A1: surface enabled queues whose transport we don't poll (e.g. PIPE) instead of
    // silently ignoring them — their mail is fed via POST /api/inbound/pipe.
    const enabledNonImap = await this.prisma.emailQueue.findMany({
      where: { isEnabled: true, type: { not: 'IMAP' } },
      select: { id: true, emailAddress: true, type: true },
    });
    for (const q of enabledNonImap) {
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

    if (!this.config.TELECOM_HD_IMAP_ENABLED) {
      this.logger.log('IMAP polling disabled (TELECOM_HD_IMAP_ENABLED=false) — drain active for PIPE');
      return;
    }

    const queues = await this.prisma.emailQueue.findMany({
      where: { isEnabled: true, type: 'IMAP' },
    });
    if (queues.length === 0) {
      this.logger.log('No enabled IMAP queues — inbound mail polling disabled (drain active for PIPE)');
      return;
    }

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
    }

    this.pollHandle = setInterval(() => {
      void this.pollAll().catch((err: unknown) => this.logger.error(`IMAP poll error: ${String(err)}`));
    }, 60_000);

    this.logger.log(`IMAP inbound polling started for ${queues.length} queue(s)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollHandle) clearInterval(this.pollHandle);
    if (this.drainHandle) clearInterval(this.drainHandle);
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
      this.logger.log(`IMAP connected to queue ${queueId} (${opts.host}:${opts.port})`);
      // Capture the baseline SYNCHRONOUSLY at activation (not on the first 60s poll) so
      // mail arriving between connect and the first poll is not skipped (P0-2).
      await this.bootstrapQueue(queueId, client);
    } catch (err) {
      this.logger.error(`Failed to connect IMAP queue ${queueId}: ${String(err)}`);
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
      const backfill =
        this.config.TELECOM_HD_IMAP_BOOTSTRAP_POLICY === 'BACKFILL'
          ? this.config.TELECOM_HD_IMAP_BACKFILL_LIMIT
          : 0;
      const baseline = Math.max(highWater - backfill, 0);
      // CAS on uidValidity IS NULL so two pods bootstrapping the same fresh queue can't
      // write different baselines — the first wins, the loser's updateMany matches 0 rows.
      const cas = await this.prisma.emailQueue.updateMany({
        where: { id: queueId, uidValidity: null },
        data: { lastSeenUid: baseline, uidValidity, syncState: 'OK', lastError: null },
      });
      if (cas.count === 0) {
        this.logger.log(`IMAP queue ${queueId}: bootstrap already done by another worker`);
        return;
      }
      this.logger.log(
        `IMAP queue ${queueId}: bootstrap ${this.config.TELECOM_HD_IMAP_BOOTSTRAP_POLICY} at uid=${baseline} ` +
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

  private async pollAll(): Promise<void> {
    for (const [queueId, client] of this.connections) {
      try {
        await this.pollQueue(queueId, client);
      } catch (err) {
        this.logger.error(`IMAP poll failed for queue ${queueId}: ${String(err)}`);
      }
    }
    await this.drainDeliveries();
  }

  private async pollQueue(queueId: number, client: ImapFlow): Promise<void> {
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
          const msg = `UIDVALIDITY changed ${queue.uidValidity} → ${uidValidity}`;
          await this.prisma.emailQueue.update({
            where: { id: queueId },
            data: { syncState: 'NEEDS_RECONCILIATION', lastError: msg },
          });
          this.logger.error(`IMAP queue ${queueId}: ${msg} — queue halted (NEEDS_RECONCILIATION)`);
          return;
        }

        const lastUid = queue.lastSeenUid;
        // Discover new UIDs first (uid-only), then fetch+accept each in ascending order
        // so out-of-order server responses can't make the cursor leapfrog a gap.
        const uids: number[] = [];
        for await (const m of client.fetch(`${lastUid + 1}:*`, { uid: true }, { uid: true })) {
          if (typeof m.uid === 'number' && m.uid > lastUid) uids.push(m.uid);
        }
        uids.sort((a, b) => a - b);

        let cursor = lastUid;
        for (const uid of uids) {
          try {
            const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
            if (!msg || !msg.source) {
              // Vanished (EXPUNGE) between discovery and fetch — nothing to accept.
              cursor = uid;
              continue;
            }
            await this.acceptImapMessage(queueId, queue.departmentId ?? null, uidValidity, uid, msg.source);
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
              lastSeenUid: { lt: cursor },
              cursorGeneration: queue.cursorGeneration,
              uidValidity: queue.uidValidity,
              syncState: 'OK',
              isEnabled: true,
            },
            data: { lastSeenUid: cursor },
          });
          if (cas.count === 0) {
            this.logger.warn(`IMAP queue ${queueId}: cursor CAS skipped (queue reconciled mid-poll)`);
          }
        }
      } finally {
        lock.release();
      }
    }

    await this.drainDeliveries();
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
    try {
      await this.prisma.inboundDelivery.create({
        data: {
          transport: 'IMAP',
          queueId,
          departmentId, // snapshot at acceptance
          transportKey,
          uidValidity,
          uid,
          contentHash,
          rawMime: new Uint8Array(source),
          sizeBytes: source.length,
          state: 'ACCEPTED',
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) return; // already accepted — idempotent
      throw err;
    }
  }

  // ─────────────────── PIPE ingress ───────────────────

  /**
   * Public entry for the MTA/PIPE webhook. Records the message in the ledger (idempotent
   * by content hash or the caller-supplied delivery id) and processes it inline so the
   * caller sees the ticket immediately; a transient failure leaves a RETRY the drain
   * picks up. Signature kept `(source, departmentId)` for the webhook controller.
   */
  async ingestRawMessage(
    source: Buffer | string,
    departmentId: number | undefined,
    externalId?: string,
  ): Promise<void> {
    const buf = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    const contentHash = createHash('sha256').update(buf).digest('hex');
    const transportKey = externalId ? `pipe:-:${externalId}` : `pipe:-:sha256:${contentHash}`;

    let deliveryId: number | null = null;
    try {
      const created = await this.prisma.inboundDelivery.create({
        data: {
          transport: 'PIPE',
          transportKey,
          externalId: externalId ?? null,
          contentHash,
          rawMime: new Uint8Array(buf),
          sizeBytes: buf.length,
          state: 'ACCEPTED',
        },
        select: { id: true },
      });
      deliveryId = created.id;
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        // A reused delivery id (or content hash) already exists. If the content matches,
        // this is an idempotent re-delivery — no-op. If it DIFFERS, the caller reused an
        // `x-inbound-delivery-id` for a DIFFERENT message: reject 409 so the second
        // message is not silently lost (rather than dropping it).
        const prior = await this.prisma.inboundDelivery.findUnique({
          where: { transportKey },
          select: { contentHash: true },
        });
        if (prior && prior.contentHash !== contentHash) {
          throw new ConflictException(
            `Inbound delivery id already used for a different message (contentHash mismatch)`,
          );
        }
        this.logger.log(`PIPE: duplicate delivery (${transportKey}) — already accepted`);
        return; // idempotent re-delivery
      }
      throw err;
    }
    await this.processDelivery(deliveryId, departmentId);
  }

  // ─────────────────── drain (process ledger) ───────────────────

  /**
   * Process due deliveries in id order: fresh `ACCEPTED`/`RETRY` work, plus any
   * `PROCESSING` whose lease has expired (a worker crashed mid-processing) — so a
   * delivery can never be stranded in `PROCESSING` forever.
   */
  async drainDeliveries(): Promise<void> {
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
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + InboundMailService.LEASE_MS);
    const claim = await this.prisma.inboundDelivery.updateMany({
      where: {
        id: deliveryId,
        OR: [
          { state: { in: ['ACCEPTED', 'RETRY'] } },
          { state: 'PROCESSING', leaseExpiresAt: { lt: now } }, // reclaim expired lease
        ],
      },
      data: { state: 'PROCESSING', leaseOwner: this.instanceId, leaseExpiresAt: leaseUntil },
    });
    if (claim.count === 0) return; // another worker holds a live lease, or already terminal

    const delivery = await this.prisma.inboundDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery) return;

    // All terminal/retry writes are CAS-gated on our lease so a worker that reclaimed an
    // expired lease can't be overwritten by the original stalled worker.
    const settle = (data: Record<string, unknown>) =>
      this.prisma.inboundDelivery.updateMany({
        where: { id: deliveryId, leaseOwner: this.instanceId, state: 'PROCESSING' },
        data,
      });

    if (!delivery.rawMime) {
      await settle({
        state: 'QUARANTINED',
        lastError: 'missing rawMime',
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      this.logger.error(`Inbound delivery ${deliveryId}: missing rawMime — quarantined`);
      return;
    }

    try {
      const outcome = await this.processRawMessage(Buffer.from(delivery.rawMime), departmentId, deliveryId);
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
      const attempts = delivery.attempts + 1;
      if (attempts >= this.maxAttempts) {
        await settle({
          state: 'QUARANTINED',
          attempts,
          lastError: String(err),
          leaseOwner: null,
          leaseExpiresAt: null,
        });
        this.logger.error(
          `Inbound delivery ${deliveryId}: QUARANTINED after ${attempts} attempts (raw MIME retained for replay) — ${String(err)}`,
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
    }
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
    deliveryId?: number,
  ): Promise<ProcessOutcome> {
    const { simpleParser } = await import('mailparser');
    const parsed = await simpleParser(source);
    const subject = parsed.subject ?? '(no subject)';
    const from = parsed.from?.value?.[0];
    const fromEmail = from?.address ?? 'unknown@example.com';
    const fromName = from?.name ?? fromEmail;
    const toField = parsed.to;
    const toAddress = !Array.isArray(toField)
      ? toField?.value?.[0]?.address
      : toField?.[0]?.value?.[0]?.address;

    // A5(ii): drop machine-generated / looping mail before it can create a ticket/reply.
    if (this.isLoopMessage(parsed, fromEmail)) {
      this.logger.log(`Inbound: skipped auto/loop message from ${fromEmail} — "${subject}"`);
      return { state: 'SKIPPED' };
    }

    // Effective Message-ID: the real RFC id, or a deterministic synthetic one derived
    // from the content hash when the message carries none. Used for BOTH dedup and the
    // stored post id, so a retry (or IMAP+PIPE double-delivery) is idempotent even for
    // mail with no Message-ID (closes the out-of-order-without-Message-ID dup gap).
    const rawBuf = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
    const realMessageId = parsed.messageId?.trim() || undefined;
    const effectiveMessageId =
      realMessageId ?? `<inbound-${createHash('sha256').update(rawBuf).digest('hex')}@23telecom.local>`;

    // ATOMIC dedup claim (race-safe): stamp the effective Message-ID + parsed identity on
    // THIS ledger row. The partial-unique index on `messageId` means only one delivery
    // can own it — a concurrent IMAP+PIPE (or two-poller) duplicate loses the race with
    // P2002 and is SKIPPED, instead of both check-then-act creating a ticket.
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
    // (e.g. a retry after the post was created). Returns the existing ids for observability.
    const existing = await this.prisma.ticketPost.findFirst({
      where: { messageId: effectiveMessageId },
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
        );
        stagedAttachmentIds = uploaded.map((a) => a.id);
      }
      return stagedAttachmentIds;
    };

    // RFC threading identifiers. Filter empties so a blank id can never match the ''
    // default on legacy posts.
    const inReplyTo = parsed.inReplyTo ?? undefined;
    const references = (parsed.references as string[] | string | undefined) ?? undefined;
    const referencedIds: string[] = [];
    if (inReplyTo) referencedIds.push(inReplyTo);
    if (references) {
      if (Array.isArray(references)) referencedIds.push(...references);
      else referencedIds.push(...String(references).split(/\s+/));
    }
    const cleanReferencedIds = referencedIds.filter((id) => id && id.trim().length > 0);

    // 1. Thread by In-Reply-To / References (possession of a real Message-ID is proof).
    if (cleanReferencedIds.length > 0) {
      const linkedPost = await this.prisma.ticketPost.findFirst({
        where: { messageId: { in: cleanReferencedIds } },
        include: { ticket: true },
      });
      if (linkedPost) {
        const post = await this.ticketsService.reply(linkedPost.ticketId, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: await attachmentIds(),
          messageId: effectiveMessageId,
        });
        this.logger.log(`Inbound: RFC-threaded reply to ${linkedPost.ticket.mask} from ${fromEmail}`);
        return { state: 'PROCESSED', ticketId: linkedPost.ticketId, postId: post.id };
      }
    }

    // 2. Thread by subject mask — but only for the ticket's own requester (a mask is
    // guessable). NotFound / sender-mismatch → new ticket; any OTHER error propagates so
    // the delivery is retried, not silently turned into a duplicate ticket (IN-10).
    const maskMatch = MASK_RE.exec(subject);
    if (maskMatch) {
      const mask = maskMatch[0].toUpperCase();
      let maskTicket: { id: number; requesterEmail: string | null } | null = null;
      try {
        const t = await this.ticketsService.getTicketByMask(mask);
        const senderOwns = (t.requesterEmail ?? '').trim().toLowerCase() === fromEmail.toLowerCase();
        if (senderOwns) {
          maskTicket = { id: t.id, requesterEmail: t.requesterEmail };
        } else {
          this.logger.warn(
            `Inbound: mask ${mask} but sender ${fromEmail} is not the requester — creating new ticket`,
          );
        }
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
        this.logger.warn(`Inbound: mask ${mask} in subject but ticket not found — creating new`);
      }
      if (maskTicket) {
        const post = await this.ticketsService.reply(maskTicket.id, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: await attachmentIds(),
          messageId: effectiveMessageId,
        });
        this.logger.log(`Inbound: threaded reply to ${mask} from ${fromEmail}`);
        return { state: 'PROCESSED', ticketId: maskTicket.id, postId: post.id };
      }
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
      messageId: effectiveMessageId,
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
    // form like `Name <addr>` — compare the bare address, not the whole string.
    const ownAddr = this.extractAddress(this.config.TELECOM_HD_MAIL_FROM ?? '');
    if (ownAddr && fromEmail.toLowerCase() === ownAddr) return true;

    return false;
  }

  /** Extract the bare lowercased email address from a `Name <addr>` / `addr` string. */
  private extractAddress(value: string): string {
    const angle = /<([^>]+)>/.exec(value);
    return (angle?.[1] ?? value).trim().toLowerCase();
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
