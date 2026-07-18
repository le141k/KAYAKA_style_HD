import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
  Optional,
  PayloadTooLargeException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ImapFlow, FetchMessageObject } from 'imapflow';
import type { AddressObject, ParsedMail } from 'mailparser';
import { TicketsService } from '../tickets/tickets.service';
import { MailService } from './mail.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { decryptField } from '../../common/field-encrypt.util';
import { stripQuotedReply } from './quoted-reply.util';
import type { EmailParserRule, Prisma } from '@prisma/client';
import { Readable } from 'node:stream';
import { normalizeEmail } from '../../common/email.util';

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

/** Ticket mask pattern used to thread inbound replies, e.g. TT-000042 */
const MASK_RE = /TT-\d{6,}/i;

const IMAP_ERROR_MAILBOX = 'Helpdesk-Processing-Errors';
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
const MAX_CONCURRENT_PARSERS = 2;
const MAX_QUEUED_PARSERS = 32;
const MAX_PROCESSING_ATTEMPTS = 3;
const MAX_PENDING_FAILURES = 100;
const MAX_DEAD_LETTER_RECORDS = 100;

interface ImapFailureState {
  uid: number;
  status: 'pending' | 'quarantined' | 'missing';
  attempts: number;
  lastFailedAt: string;
}

interface ImapQueueState {
  uidValidity: string;
  watermark: number;
  failures: ImapFailureState[];
}

interface ThreadableTicket {
  id: number;
  requesterEmail: string | null;
  user?: { emails: Array<{ email: string }> } | null;
  recipients?: Array<{ email: string }>;
}

/**
 * IMAP inbound mail service.
 *
 * When TELECOM_HD_IMAP_ENABLED=true (checked at runtime from the EmailQueue table),
 * this service polls each enabled IMAP queue and:
 *  1. Threads replies by RFC Message-ID / In-Reply-To / References headers.
 *  2. Falls back to TT-XXXXXX mask matching in the subject.
 *  3. Creates new tickets from unthreaded messages and sends autoresponder.
 *  4. Stores RFC Message-ID on created TicketPost.
 *  5. Sends a reply email notification on staff reply.
 *
 * TODO: replace polling with IMAP IDLE for push-based notification.
 * A per-queue UID watermark is persisted in the Setting table so a restart does
 * not re-process (and re-ticket) the entire mailbox.
 */
@Injectable()
export class InboundMailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundMailService.name);
  private readonly connections: Map<number, ImapFlow> = new Map();
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private pollInProgress = false;
  private readonly pollingQueues = new Set<number>();
  private activeParsers = 0;
  private readonly parserWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly ownAddresses = new Set<string>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TicketsService)) private readonly ticketsService: TicketsService,
    private readonly mailService: MailService,
    @Optional() private readonly attachmentsService?: AttachmentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const mailFrom = this.normalizeConfiguredMailbox(this.config.TELECOM_HD_MAIL_FROM ?? '');
    if (mailFrom) this.ownAddresses.add(mailFrom);

    // A1: surface enabled queues whose transport we don't poll (e.g. PIPE) instead
    // of silently ignoring them — their mail would otherwise be dropped on the
    // floor. PIPE/MTA queues are fed via POST /api/inbound/pipe (see controller).
    const enabledNonImap = await this.prisma.emailQueue.findMany({
      where: { isEnabled: true, type: { not: 'IMAP' } },
      select: { id: true, emailAddress: true, type: true },
    });
    for (const q of enabledNonImap) {
      this.logger.warn(
        `EmailQueue ${q.id} (type=${q.type}) is enabled but not IMAP — ` +
          `the poller will not fetch it. Use the inbound webhook (POST /api/inbound/pipe) for PIPE/MTA delivery.`,
      );
    }

    // Only start polling if at least one IMAP queue is enabled
    const queues = await this.prisma.emailQueue.findMany({
      where: { isEnabled: true, type: 'IMAP' },
    });

    for (const queue of [...enabledNonImap, ...queues]) {
      if ('emailAddress' in queue) {
        const address = normalizeEmail(queue.emailAddress);
        if (address) this.ownAddresses.add(address);
      }
    }

    if (queues.length === 0) {
      this.logger.log('No enabled IMAP queues — inbound mail polling disabled');
      return;
    }

    // Connect to each queue
    const encKey = this.config.TELECOM_HD_FIELD_ENCRYPTION_KEY;
    for (const queue of queues) {
      let plainPassword: string;
      try {
        plainPassword = decryptField(queue.passwordEnc, encKey);
      } catch {
        this.logger.error(`Failed to decrypt IMAP password for queue ${queue.id}`);
        continue;
      }
      await this.connectQueue(queue.id, {
        host: queue.host,
        port: queue.port,
        secure: queue.useTls,
        auth: {
          user: queue.username,
          pass: plainPassword,
        },
      });
    }

    // Poll every 60 seconds
    this.pollHandle = setInterval(() => {
      void this.pollAll().catch(() => this.logger.error('IMAP poll failed'));
    }, 60_000);

    this.logger.log(`IMAP inbound polling started for ${queues.length} queue(s)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollHandle) clearInterval(this.pollHandle);
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

  // ─────────────────── private ───────────────────

  private async connectQueue(
    queueId: number,
    opts: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } },
  ): Promise<void> {
    try {
      // Lazy import to avoid hard dep when IMAP is disabled
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
      this.logger.log(`IMAP connected to queue ${queueId}`);
    } catch {
      this.logger.error(`Failed to connect IMAP queue ${queueId}`);
    }
  }

  /** Poll all connected IMAP clients for unseen messages. */
  private async pollAll(): Promise<void> {
    if (this.pollInProgress) {
      this.logger.warn('IMAP poll skipped because the previous poll is still running');
      return;
    }

    this.pollInProgress = true;
    try {
      for (const [queueId, client] of this.connections) {
        try {
          await this.pollQueue(queueId, client);
        } catch {
          this.logger.error(`IMAP poll failed for queue ${queueId}`);
        }
      }
    } finally {
      this.pollInProgress = false;
    }
  }

  private async pollQueue(queueId: number, client: ImapFlow): Promise<void> {
    if (this.pollingQueues.has(queueId)) {
      this.logger.warn(`IMAP poll skipped for queue ${queueId} because it is already running`);
      return;
    }
    this.pollingQueues.add(queueId);
    try {
      const queue = await this.prisma.emailQueue.findUnique({ where: { id: queueId } });
      if (!queue) return;

      const lock = await client.getMailboxLock('INBOX');
      try {
        const uidValidity = client.mailbox ? client.mailbox.uidValidity.toString() : '';
        if (!uidValidity) {
          throw new Error('IMAP mailbox did not expose UIDVALIDITY');
        }
        let state = await this.getQueueState(queueId, uidValidity);

        // Retry durable gaps before processing new UIDs. A failed message is either
        // successfully ingested, moved to the managed error folder, or remains in
        // this list for the next poll. Later mail is never blocked by one poison UID.
        const pendingUids = state.failures
          .filter((failure) => failure.status === 'pending')
          .map((failure) => failure.uid)
          .sort((a, b) => a - b);
        for (const uid of pendingUids) {
          let found = false;
          for await (const msg of client.fetch(
            uid,
            { uid: true, envelope: true, source: this.imapSourceQuery() },
            { uid: true },
          )) {
            found = true;
            state = await this.finalizeImapMessage(
              queueId,
              client,
              msg,
              queue.departmentId ?? undefined,
              state,
            );
          }
          if (!found) {
            const previousAttempts = state.failures.find((failure) => failure.uid === uid)?.attempts ?? 0;
            const terminal = previousAttempts + 1 >= MAX_PROCESSING_ATTEMPTS;
            state = this.recordFailure(state, uid, terminal ? 'missing' : 'pending');
            await this.setQueueState(queueId, state);
            this.logger.error(
              terminal
                ? `IMAP queue ${queueId} recorded a missing poison UID as terminal`
                : `IMAP queue ${queueId} still has an unresolved missing poison UID`,
            );
          }
        }

        // The third fetch argument is essential: without `{ uid: true }`, the
        // range is interpreted as volatile sequence numbers rather than UIDs.
        const range = `${state.watermark + 1}:*`;
        for await (const msg of client.fetch(
          range,
          { uid: true, envelope: true, source: this.imapSourceQuery() },
          { uid: true },
        )) {
          if (msg.uid <= state.watermark) continue;
          state = await this.finalizeImapMessage(
            queueId,
            client,
            msg,
            queue.departmentId ?? undefined,
            state,
          );
        }
      } finally {
        lock.release();
      }
    } finally {
      this.pollingQueues.delete(queueId);
    }
  }

  private imapSourceQuery(): { maxLength: number } {
    return { maxLength: this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024 + 1 };
  }

  private async finalizeImapMessage(
    queueId: number,
    client: ImapFlow,
    msg: FetchMessageObject,
    departmentId: number | undefined,
    state: ImapQueueState,
  ): Promise<ImapQueueState> {
    let nextState = state;
    try {
      const transportMessageId = `<imap-${queueId}-${state.uidValidity}-${msg.uid}@helpdesk.invalid>`;
      await this.processMessage(msg, departmentId, transportMessageId);
      nextState = {
        ...state,
        watermark: Math.max(state.watermark, msg.uid),
        failures: state.failures.filter((failure) => failure.uid !== msg.uid),
      };
    } catch {
      const previousAttempts = state.failures.find((failure) => failure.uid === msg.uid)?.attempts ?? 0;
      let quarantined = false;
      if (previousAttempts + 1 >= MAX_PROCESSING_ATTEMPTS) {
        try {
          await this.ensureErrorMailbox(client);
          quarantined = (await client.messageMove(msg.uid, IMAP_ERROR_MAILBOX, { uid: true })) !== false;
        } catch {
          quarantined = false;
        }
      }

      nextState = this.recordFailure(state, msg.uid, quarantined ? 'quarantined' : 'pending');
      nextState.watermark = Math.max(nextState.watermark, msg.uid);
      this.logger.error(
        quarantined
          ? `IMAP queue ${queueId} quarantined a poison message in ${IMAP_ERROR_MAILBOX}`
          : previousAttempts + 1 >= MAX_PROCESSING_ATTEMPTS
            ? `IMAP queue ${queueId} retained a poison UID because quarantine failed`
            : `IMAP queue ${queueId} retained a failed UID for retry`,
      );
    }

    // Persist after every finalized or durably-recorded UID. A process crash can
    // therefore replay at most the current UID; atomic Message-ID ingestion makes
    // that replay idempotent.
    await this.setQueueState(queueId, nextState);
    return nextState;
  }

  private async ensureErrorMailbox(client: ImapFlow): Promise<void> {
    const mailboxes = await client.list();
    if (!mailboxes.some((mailbox) => mailbox.path === IMAP_ERROR_MAILBOX)) {
      await client.mailboxCreate(IMAP_ERROR_MAILBOX);
    }
  }

  private recordFailure(
    state: ImapQueueState,
    uid: number,
    status: ImapFailureState['status'],
  ): ImapQueueState {
    const existing = state.failures.find((failure) => failure.uid === uid);
    const currentPending = state.failures.filter((failure) => failure.status === 'pending');
    if (status === 'pending' && !existing && currentPending.length >= MAX_PENDING_FAILURES) {
      // Do not advance/checkpoint this UID when the durable retry set is full.
      // The next poll will fetch it again from the current watermark, while the
      // bounded Setting JSON cannot be grown indefinitely by a hostile mailbox.
      throw new ServiceUnavailableException('IMAP poison-message retry capacity is exhausted');
    }
    const failure: ImapFailureState = {
      uid,
      status,
      attempts: (existing?.attempts ?? 0) + 1,
      lastFailedAt: new Date().toISOString(),
    };
    const failures = [...state.failures.filter((item) => item.uid !== uid), failure].sort(
      (a, b) => a.uid - b.uid,
    );
    const pending = failures.filter((item) => item.status === 'pending');
    const terminal = failures
      .filter((item) => item.status === 'quarantined' || item.status === 'missing')
      .slice(-MAX_DEAD_LETTER_RECORDS);
    return {
      ...state,
      failures: [...pending, ...terminal].sort((a, b) => a.uid - b.uid),
    };
  }

  /** Setting section/key under which per-queue IMAP state is stored. */
  private static readonly UID_SETTING_SECTION = 'imap';
  private uidSettingKey(queueId: number): string {
    return `state:${queueId}`;
  }

  private legacyUidSettingKey(queueId: number): string {
    return `lastSeenUid:${queueId}`;
  }

  /** Read UIDVALIDITY, watermark and poison-message state for a queue. */
  private async getQueueState(queueId: number, uidValidity: string): Promise<ImapQueueState> {
    const row = await this.prisma.setting.findUnique({
      where: {
        section_key: {
          section: InboundMailService.UID_SETTING_SECTION,
          key: this.uidSettingKey(queueId),
        },
      },
    });
    const value = row?.value as Partial<ImapQueueState> | undefined;
    if (
      value &&
      value.uidValidity === uidValidity &&
      typeof value.watermark === 'number' &&
      Number.isSafeInteger(value.watermark) &&
      value.watermark >= 0
    ) {
      const failures = Array.isArray(value.failures) ? value.failures.filter(this.isValidFailureState) : [];
      return { uidValidity, watermark: value.watermark, failures };
    }

    // A UID is meaningful only inside one UIDVALIDITY generation. Reusing the
    // old numeric watermark after a server-side mailbox rebuild can silently
    // skip new mail or re-ingest old mail. Fail closed and require an operator to
    // inspect/reset this one Setting row rather than guessing across generations.
    if (value?.uidValidity && value.uidValidity !== uidValidity) {
      this.logger.error(`IMAP UIDVALIDITY changed for queue ${queueId}; polling is paused`);
      throw new ServiceUnavailableException('IMAP UIDVALIDITY changed; manual queue-state reset required');
    }

    // One-time compatibility with the old numeric watermark. Associate it with
    // the currently-open mailbox's UIDVALIDITY, then persist the richer state.
    const legacy = await this.prisma.setting.findUnique({
      where: {
        section_key: {
          section: InboundMailService.UID_SETTING_SECTION,
          key: this.legacyUidSettingKey(queueId),
        },
      },
    });
    const legacyWatermark = legacy?.value;
    const watermark =
      typeof legacyWatermark === 'number' && Number.isSafeInteger(legacyWatermark) && legacyWatermark >= 0
        ? legacyWatermark
        : 0;
    const initial: ImapQueueState = { uidValidity, watermark, failures: [] };
    await this.setQueueState(queueId, initial);
    return initial;
  }

  private readonly isValidFailureState = (value: unknown): value is ImapFailureState => {
    if (!value || typeof value !== 'object') return false;
    const item = value as Partial<ImapFailureState>;
    return (
      typeof item.uid === 'number' &&
      Number.isSafeInteger(item.uid) &&
      item.uid > 0 &&
      (item.status === 'pending' || item.status === 'quarantined' || item.status === 'missing') &&
      typeof item.attempts === 'number' &&
      Number.isSafeInteger(item.attempts) &&
      item.attempts > 0 &&
      typeof item.lastFailedAt === 'string'
    );
  };

  private async setQueueState(queueId: number, state: ImapQueueState): Promise<void> {
    const value: Prisma.InputJsonObject = {
      uidValidity: state.uidValidity,
      watermark: state.watermark,
      failures: state.failures.map((failure) => ({ ...failure })),
    };
    await this.prisma.setting.upsert({
      where: {
        section_key: {
          section: InboundMailService.UID_SETTING_SECTION,
          key: this.uidSettingKey(queueId),
        },
      },
      create: {
        section: InboundMailService.UID_SETTING_SECTION,
        key: this.uidSettingKey(queueId),
        value,
      },
      update: { value },
    });
  }

  /**
   * Process one inbound IMAP message.
   * Threading priority:
   *   1. In-Reply-To / References header → look up TicketPost.messageId
   *   2. Subject mask TT-XXXXXX
   *   3. Apply parser rules (PRE_PARSE) — may discard or override routing
   *   4. Fall back to creating a new ticket
   */
  /**
   * A5(ii): true when an inbound message looks machine-generated or self-sent, so
   * we must not auto-reply to it. Checks RFC 3834 Auto-Submitted, Precedence:bulk/
   * list/junk, any X-Loop, and a From that matches our own MAIL_FROM / a configured
   * queue address (self-loop).
   */
  private isLoopMessage(parsed: { headers?: Map<string, unknown> }, fromEmail: string): boolean {
    const headers = parsed.headers;
    // A header can arrive as a string, an array (repeated header lines), or a
    // structured object (mailparser parses params). Flatten all to a lowercased
    // string so a multi-valued `Precedence: list` + `Precedence: bulk` (array) or
    // a parameterised value can't slip past the checks below.
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
    // True if any whitespace/comma-separated token of the header equals one of `tokens`.
    const hasToken = (headerVal: string, tokens: string[]): boolean => {
      const parts = headerVal.split(/[\s,;]+/).filter(Boolean);
      return parts.some((p) => tokens.includes(p));
    };

    const autoSubmitted = get('auto-submitted');
    // Anything other than an explicit "no" (incl. multi/parameterised) is a loop.
    if (autoSubmitted && !hasToken(autoSubmitted, ['no'])) return true;

    const precedence = get('precedence');
    if (hasToken(precedence, ['bulk', 'list', 'junk', 'auto_reply'])) return true;

    if (get('x-loop') || get('x-autoreply') || get('x-autorespond')) return true;

    // Self-from: never react to mail we ourselves sent.
    const normalizedFrom = normalizeEmail(fromEmail);
    const configuredFrom = this.normalizeConfiguredMailbox(this.config.TELECOM_HD_MAIL_FROM ?? '');
    if (normalizedFrom && (normalizedFrom === configuredFrom || this.ownAddresses.has(normalizedFrom))) {
      return true;
    }

    return false;
  }

  private async processMessage(
    msg: FetchMessageObject,
    departmentId: number | undefined,
    transportMessageId?: string,
  ): Promise<void> {
    const source = msg.source;
    if (!source) throw new BadRequestException('IMAP message source is unavailable');
    await this.ingestRawMessage(source, departmentId, transportMessageId);
  }

  /**
   * Parse a raw RFC822 message and route it (thread / new ticket). Shared by the
   * IMAP poller and the inbound webhook (A1) so both transports behave identically.
   */
  async ingestRawMessage(
    source: Buffer | string | Readable,
    departmentId: number | undefined,
    transportMessageId?: string,
  ): Promise<void> {
    const maxBytes = this.config.TELECOM_HD_INBOUND_MAX_SIZE_MB * 1024 * 1024;
    const boundedSource = this.boundedInboundSource(source, maxBytes);
    const parsed = await this.withParserSlot(async () => {
      const { simpleParser } = await import('mailparser');
      return simpleParser(boundedSource);
    });
    this.validateParsedMail(parsed);

    const subject = (parsed.subject ?? '(no subject)').trim() || '(no subject)';
    const from = parsed.from?.value?.[0];
    const fromEmail = normalizeEmail(from?.address ?? '');
    if (!this.isPlausibleEmail(fromEmail)) {
      throw new BadRequestException('Inbound message has no valid From address');
    }
    const fromName = (from?.name ?? fromEmail).trim() || fromEmail;

    // A5(ii): drop machine-generated / looping mail before it can create a ticket
    // or reply (which would trigger our autoresponder and ping-pong).
    if (this.isLoopMessage(parsed, fromEmail)) {
      this.logger.log('IMAP: skipped auto/loop message');
      return;
    }

    // A3 dedup: if we've already ingested a post bearing this exact Message-ID,
    // this is a re-delivery (re-poll, or the same mail arriving via IMAP + webhook)
    // — skip it so no duplicate ticket/reply is created. Empty IDs are never matched.
    const incomingMessageId =
      this.normalizeMessageId(parsed.messageId) ?? this.normalizeMessageId(transportMessageId);
    if (incomingMessageId) {
      const existing = await this.prisma.ticketPost.findFirst({
        where: { messageId: incomingMessageId },
        select: { id: true },
      });
      if (existing) {
        this.logger.log('IMAP: duplicate message skipped');
        return;
      }
    }

    // Strip the quoted reply history so a threaded reply stores only the new text
    // (Kayako keeps the whole quoted chain on every message). HTML is left as-is —
    // the plain-text body is what we persist when there is no HTML part.
    const textBody = stripQuotedReply(parsed.text ?? '');
    const htmlBody = parsed.html || undefined;

    // Persist email attachments if AttachmentsService is available
    let emailAttachmentIds: number[] = [];
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
      emailAttachmentIds = uploaded.map((a) => a.id);
    }

    // RFC threading identifiers (incomingMessageId already resolved above for dedup).
    const inReplyTo = this.normalizeMessageId(parsed.inReplyTo);
    const references = parsed.references ?? undefined;

    // Build list of message IDs from In-Reply-To and References to try.
    // Filter empties so a blank id can never match the '' default on legacy posts.
    const referencedIds: string[] = [];
    if (inReplyTo) referencedIds.push(inReplyTo);
    if (references) {
      if (Array.isArray(references)) {
        referencedIds.push(
          ...references
            .map((id) => this.normalizeMessageId(id))
            .filter((id): id is string => id !== undefined),
        );
      } else {
        referencedIds.push(
          ...String(references)
            .split(/\s+/)
            .map((id) => this.normalizeMessageId(id))
            .filter((id): id is string => id !== undefined),
        );
      }
    }
    const cleanReferencedIds = [...new Set(referencedIds)].slice(0, MAX_REFERENCES);

    // 1. Try RFC threading by In-Reply-To / References
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
        await this.ticketsService.reply(linkedPost.ticketId, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: emailAttachmentIds,
          incomingMessageId,
        });
        this.logger.log(`IMAP: RFC-threaded reply to ticketId ${linkedPost.ticketId}`);
        return;
      }
      if (linkedPost) {
        this.logger.warn('IMAP: RFC-thread sender was not authorized for the ticket');
      }
    }

    // 2. Thread by mask in subject
    const maskMatch = MASK_RE.exec(subject);
    if (maskMatch) {
      const mask = maskMatch[0].toUpperCase();
      const ticket = await this.prisma.ticket.findUnique({
        where: { mask },
        select: {
          id: true,
          requesterEmail: true,
          user: { select: { emails: { select: { email: true } } } },
          recipients: { select: { email: true } },
        },
      });
      if (!ticket) {
        this.logger.warn('IMAP: subject mask did not resolve; creating a new ticket');
      }

      if (ticket && this.senderCanReply(ticket, fromEmail)) {
        await this.ticketsService.reply(ticket.id, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: emailAttachmentIds,
          incomingMessageId,
        });
        this.logger.log(`IMAP: subject-mask reply threaded to ticketId ${ticket.id}`);
        return;
      }
      if (ticket) {
        this.logger.warn('IMAP: subject-mask sender was not authorized for the ticket');
      }
    }

    // 3. Apply PRE_PARSE parser rules (before creating a new ticket)
    const toField = parsed.to;
    const toAddress = !Array.isArray(toField)
      ? toField?.value?.[0]?.address
      : toField?.[0]?.value?.[0]?.address;
    const parsedEmail: ParsedEmail = {
      subject,
      fromEmail,
      fromName,
      toEmail: toAddress,
      body: textBody,
    };
    const ruleResult = await this.applyParserRules(parsedEmail, departmentId);

    if (ruleResult.skip) {
      this.logger.log('IMAP: message discarded by parser rule');
      return;
    }

    // 4. Create new ticket
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
      attachmentIds: emailAttachmentIds,
      ...(ruleResult.priorityId !== undefined ? { priorityId: ruleResult.priorityId } : {}),
      ...(ruleResult.ownerStaffId !== undefined ? { ownerStaffId: ruleResult.ownerStaffId } : {}),
      incomingMessageId,
    });

    // NOTE: the autoresponder is sent by TicketsService.createTicket() (it fires for
    // every requesterEmail on creation). Sending it again here produced a duplicate
    // autoresponder for every inbound email — removed intentionally.

    this.logger.log(`IMAP: created ticketId ${newTicket.id}`);
  }

  /** At most two MIME trees are materialized at once; excess work is bounded. */
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
    // The active counter represents permits. releaseParserSlot() transfers the
    // permit directly to the oldest waiter without decrementing it first.
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

  /** Cap buffers immediately and streams while mailparser consumes them. */
  private boundedInboundSource(
    source: Buffer | string | Readable,
    maxBytes: number,
  ): Buffer | string | Readable {
    if (!source || typeof source === 'string' || Buffer.isBuffer(source)) {
      const bytes = Buffer.isBuffer(source) ? source.length : Buffer.byteLength(source);
      if (bytes > maxBytes) {
        throw new PayloadTooLargeException('Inbound message exceeds the configured size limit');
      }
      return source;
    }

    const bounded = async function* () {
      let bytes = 0;
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          throw new PayloadTooLargeException('Inbound message exceeds the configured size limit');
        }
        yield buffer;
      }
    };
    return Readable.from(bounded());
  }

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
    } catch {
      // Table may not exist yet (migration pending) — skip rules gracefully
      return result;
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

      // Apply actions
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
   * JavaScript RegExp has no execution timeout. Accept a deliberately small,
   * linear-time subset for database parser rules: literals/classes/anchors with
   * at most one simple quantifier. Groups, alternation, lookarounds, backrefs and
   * counted/nested quantifiers are rejected instead of risking event-loop ReDoS.
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
        // Numeric/named backreferences and Unicode property escapes are outside
        // the safe subset. Ordinary escaped literals and \d/\s/\w are fine.
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

    // An unanchored `.*suffix` still permits quadratic rescanning at every start
    // position even without groups. Require a start anchor for * / + patterns.
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
