import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Inject,
  forwardRef,
  Optional,
} from '@nestjs/common';
import type { ImapFlow, FetchMessageObject } from 'imapflow';
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

/** Ticket mask pattern used to thread inbound replies, e.g. TT-000042 */
const MASK_RE = /TT-\d{6,}/i;

/**
 * Per-queue IMAP cursor. `uid` is the highest UID we have fully processed;
 * `uidValidity` is the mailbox's UIDVALIDITY at the time (0/null = unknown, e.g.
 * migrated from the legacy bare-number watermark format).
 */
interface Watermark {
  uid: number;
  uidValidity: number | null;
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

  /**
   * In-memory per-message failure counter keyed by `queueId:uidValidity:uid`.
   * A message that keeps throwing is retried on subsequent polls up to
   * {@link MAX_POISON_ATTEMPTS}, then quarantined (logged and skipped) so a single
   * poison message can never wedge the whole queue. This is an interim safeguard;
   * the durable `InboundDelivery` ledger (see docs/api/internal.md) is the target.
   */
  private readonly pollAttempts = new Map<string, number>();
  private static readonly MAX_POISON_ATTEMPTS = 5;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TicketsService)) private readonly ticketsService: TicketsService,
    private readonly mailService: MailService,
    @Optional() private readonly attachmentsService?: AttachmentsService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Only start if at least one IMAP queue is enabled
    const queues = await this.prisma.emailQueue.findMany({
      where: { isEnabled: true, type: 'IMAP' },
    });

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
      } catch (err) {
        this.logger.error(`Failed to decrypt IMAP password for queue ${queue.id}: ${String(err)}`);
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
      void this.pollAll().catch((err: unknown) => this.logger.error(`IMAP poll error: ${String(err)}`));
    }, 60_000);

    this.logger.log(`IMAP inbound polling started for ${queues.length} queue(s)`);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pollHandle) clearInterval(this.pollHandle);
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
      this.logger.log(`IMAP connected to queue ${queueId} (${opts.host}:${opts.port})`);
    } catch (err) {
      this.logger.error(`Failed to connect IMAP queue ${queueId}: ${String(err)}`);
    }
  }

  /** Poll all connected IMAP clients for unseen messages. */
  private async pollAll(): Promise<void> {
    for (const [queueId, client] of this.connections) {
      try {
        await this.pollQueue(queueId, client);
      } catch (err) {
        this.logger.error(`IMAP poll failed for queue ${queueId}: ${String(err)}`);
      }
    }
  }

  private async pollQueue(queueId: number, client: ImapFlow): Promise<void> {
    const queue = await this.prisma.emailQueue.findUnique({ where: { id: queueId } });
    if (!queue) return;

    const lock = await client.getMailboxLock('INBOX');
    try {
      const { uidValidity, uidNext } = this.readMailboxState(client);
      const watermark = await this.getWatermark(queueId);

      // IN-02 / IN-01: bootstrap NOW. On the very first poll (no watermark) — or when
      // the server has reset its UID space (UIDVALIDITY changed) — do NOT walk the
      // historical INBOX. Record the current high-water UID and process only mail that
      // arrives afterwards. This prevents mass historical ticket creation and blasting
      // autoresponders at old senders after a fresh connect or a UIDVALIDITY rollover.
      const validityChanged =
        watermark !== null &&
        watermark.uidValidity !== null &&
        uidValidity !== undefined &&
        watermark.uidValidity !== uidValidity;

      if (watermark === null || validityChanged) {
        const startUid = uidNext !== undefined ? Math.max(uidNext - 1, 0) : (watermark?.uid ?? 0);
        await this.setWatermark(queueId, { uid: startUid, uidValidity: uidValidity ?? 0 });
        this.logger.log(
          validityChanged
            ? `IMAP queue ${queueId}: UIDVALIDITY changed → rebootstrap at uid=${startUid}, existing mail skipped`
            : `IMAP queue ${queueId}: bootstrap NOW at uid=${startUid} (uidValidity=${uidValidity ?? 'n/a'}), existing mail skipped`,
        );
        return;
      }

      const lastUid = watermark.uid;
      // The stored uidValidity we key retries and the next watermark write against.
      // Legacy watermarks carry a null uidValidity; adopt the server's on first sight.
      const effectiveValidity = uidValidity ?? watermark.uidValidity;

      // IN-01: `<uid>:*` is only interpreted as a UID range when `{ uid: true }` is
      // passed as the THIRD fetch() argument. Placing it in the query object (2nd arg)
      // leaves the range as a *sequence* range, which drifts from UIDs after EXPUNGE
      // and can silently stop delivering new mail.
      const range = `${lastUid + 1}:*`;
      let cursor = lastUid;

      for await (const msg of client.fetch(range, { envelope: true, source: true }, { uid: true })) {
        // `<n>:*` always echoes the highest message even when nothing is new — and the
        // range may include the boundary — so skip anything at or below the cursor.
        if (msg.uid <= cursor) continue;

        const attemptKey = `${queueId}:${effectiveValidity ?? 0}:${msg.uid}`;
        try {
          await this.processMessage(msg, queue.departmentId ?? undefined);
          this.pollAttempts.delete(attemptKey);
          cursor = msg.uid;
        } catch (err) {
          // IN-03: isolate poison messages. Retry a failing UID a bounded number of
          // times across polls; once exhausted, quarantine it (log + advance past) so
          // it stops blocking every later message. Below the limit we stop this poll
          // WITHOUT advancing the watermark, so ordering is preserved and no message is
          // skipped — the same UID (and everything after it) is retried next poll.
          const attempts = (this.pollAttempts.get(attemptKey) ?? 0) + 1;
          if (attempts >= InboundMailService.MAX_POISON_ATTEMPTS) {
            this.pollAttempts.delete(attemptKey);
            this.logger.error(
              `IMAP queue ${queueId}: quarantining poison message uid=${msg.uid} after ${attempts} attempts — ${String(err)}`,
            );
            cursor = msg.uid; // advance past the poison message
            continue;
          }
          this.pollAttempts.set(attemptKey, attempts);
          this.logger.warn(
            `IMAP queue ${queueId}: message uid=${msg.uid} failed (attempt ${attempts}/${InboundMailService.MAX_POISON_ATTEMPTS}), will retry — ${String(err)}`,
          );
          break;
        }
      }

      // Persist when we advanced, or when we just learned the server's UIDVALIDITY for
      // a legacy (null) watermark — so the next poll can detect a future rollover.
      const learnedValidity = watermark.uidValidity === null && uidValidity !== undefined;
      if (cursor > lastUid || learnedValidity) {
        await this.setWatermark(queueId, { uid: cursor, uidValidity: effectiveValidity ?? 0 });
      }
    } finally {
      lock.release();
    }
  }

  /**
   * Read UIDVALIDITY / UIDNEXT from the currently-selected mailbox. ImapFlow exposes
   * these on `client.mailbox` after a mailbox lock is held (`false` when none open).
   * UIDVALIDITY is a BigInt on the wire — normalised to a JS number for storage.
   */
  private readMailboxState(client: ImapFlow): { uidValidity?: number; uidNext?: number } {
    const mailbox = (client as { mailbox?: unknown }).mailbox;
    if (!mailbox || typeof mailbox !== 'object') return {};
    const mb = mailbox as { uidValidity?: unknown; uidNext?: unknown };
    const uidValidity =
      mb.uidValidity != null && Number.isFinite(Number(mb.uidValidity)) ? Number(mb.uidValidity) : undefined;
    const uidNext = typeof mb.uidNext === 'number' && Number.isFinite(mb.uidNext) ? mb.uidNext : undefined;
    return { uidValidity, uidNext };
  }

  /** Setting section/key under which per-queue IMAP UID watermarks are stored. */
  private static readonly UID_SETTING_SECTION = 'imap';
  private uidSettingKey(queueId: number): string {
    return `lastSeenUid:${queueId}`;
  }

  /**
   * Read the persisted watermark for a queue, or `null` if none exists (never polled).
   * Supports the legacy bare-number format (`value: <uid>`) by returning it with an
   * unknown (null) uidValidity, so an already-running queue keeps its cursor rather
   * than re-bootstrapping and skipping mail on the first poll after upgrade.
   */
  private async getWatermark(queueId: number): Promise<Watermark | null> {
    const row = await this.prisma.setting.findUnique({
      where: {
        section_key: {
          section: InboundMailService.UID_SETTING_SECTION,
          key: this.uidSettingKey(queueId),
        },
      },
    });
    const value = row?.value;
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { uid: value, uidValidity: null };
    }
    if (typeof value === 'object' && !Array.isArray(value)) {
      const v = value as { uid?: unknown; uidValidity?: unknown };
      const uid = typeof v.uid === 'number' && Number.isFinite(v.uid) ? v.uid : 0;
      const uidValidity =
        typeof v.uidValidity === 'number' && Number.isFinite(v.uidValidity) ? v.uidValidity : null;
      return { uid, uidValidity };
    }
    return null;
  }

  /** Persist the watermark (UID cursor + UIDVALIDITY) for a queue. */
  private async setWatermark(queueId: number, wm: Watermark): Promise<void> {
    const value = { uid: wm.uid, uidValidity: wm.uidValidity ?? 0 };
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
  private async processMessage(msg: FetchMessageObject, departmentId: number | undefined): Promise<void> {
    const { simpleParser } = await import('mailparser');
    const source = msg.source;
    if (!source) return;

    const parsed = await simpleParser(source);
    const subject = parsed.subject ?? '(no subject)';
    const from = parsed.from?.value?.[0];
    const fromEmail = from?.address ?? 'unknown@example.com';
    const fromName = from?.name ?? fromEmail;
    // Strip the quoted reply history so a threaded reply stores only the new text
    // (Kayako keeps the whole quoted chain on every message). HTML is left as-is —
    // the plain-text body is what we persist when there is no HTML part.
    const textBody = stripQuotedReply(parsed.text ?? '');
    const htmlBody = parsed.html || undefined;

    // RFC threading identifiers
    const incomingMessageId = parsed.messageId ?? undefined;
    const inReplyTo = parsed.inReplyTo ?? undefined;
    const references = (parsed.references as string[] | string | undefined) ?? undefined;

    // IN-03 (idempotency): if this exact Message-ID was already stored on a post, the
    // message has already been ticketed — skip it. This keeps re-processing safe when a
    // poll is retried after a transient failure, or the process crashes between the
    // reply and the watermark write. (Messages without a Message-ID still rely on the
    // UID watermark; full atomic de-dup is the durable-ledger work in IN-06.)
    if (incomingMessageId) {
      const already = await this.prisma.ticketPost.findFirst({
        where: { messageId: incomingMessageId },
        select: { id: true },
      });
      if (already) {
        this.logger.log(
          `IMAP: message ${incomingMessageId} already processed (post ${already.id}) — skipping`,
        );
        return;
      }
    }

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
      );
      emailAttachmentIds = uploaded.map((a) => a.id);
    }

    // Build list of message IDs from In-Reply-To and References to try
    const referencedIds: string[] = [];
    if (inReplyTo) referencedIds.push(inReplyTo);
    if (references) {
      if (Array.isArray(references)) {
        referencedIds.push(...references);
      } else {
        referencedIds.push(...String(references).split(/\s+/).filter(Boolean));
      }
    }

    // 1. Try RFC threading by In-Reply-To / References
    if (referencedIds.length > 0) {
      const linkedPost = await this.prisma.ticketPost.findFirst({
        where: { messageId: { in: referencedIds } },
        include: { ticket: true },
      });

      if (linkedPost) {
        await this.ticketsService.reply(linkedPost.ticketId, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: emailAttachmentIds,
        });
        // Store the incoming messageId on the new post
        if (incomingMessageId) {
          await this.storeMessageIdOnLatestPost(linkedPost.ticketId, incomingMessageId);
        }
        this.logger.log(`IMAP: RFC-threaded reply to ticket ${linkedPost.ticket.mask} from ${fromEmail}`);
        return;
      }
    }

    // 2. Thread by mask in subject
    const maskMatch = MASK_RE.exec(subject);
    if (maskMatch) {
      const mask = maskMatch[0].toUpperCase();
      // IN-10: only a genuine "ticket not found" (NotFoundException) may fall through to
      // creating a new ticket. A transient/DB/storage error must NOT be swallowed and
      // turned into a duplicate new ticket — rethrow so the poll loop retries/quarantines.
      let maskTicketId: number | null = null;
      try {
        const ticket = await this.ticketsService.getTicketByMask(mask);
        maskTicketId = ticket.id;
      } catch (err) {
        if (!(err instanceof NotFoundException)) throw err;
        this.logger.warn(`IMAP: mask ${mask} in subject but ticket not found — creating new`);
      }
      if (maskTicketId !== null) {
        await this.ticketsService.reply(maskTicketId, {
          contents: htmlBody ?? textBody,
          isHtml: !!htmlBody,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          ipAddress: '0.0.0.0',
          attachmentIds: emailAttachmentIds,
        });
        if (incomingMessageId) {
          await this.storeMessageIdOnLatestPost(maskTicketId, incomingMessageId);
        }
        this.logger.log(`IMAP: threaded reply to ${mask} from ${fromEmail}`);
        return;
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
      this.logger.log(`IMAP: message from ${fromEmail} discarded by parser rule — "${subject}"`);
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
    });

    // Store the incoming messageId on the first post
    if (incomingMessageId) {
      await this.storeMessageIdOnLatestPost(newTicket.id, incomingMessageId);
    }

    // NOTE: the autoresponder is sent by TicketsService.createTicket() (it fires for
    // every requesterEmail on creation). Sending it again here produced a duplicate
    // autoresponder for every inbound email — removed intentionally.

    this.logger.log(`IMAP: new ticket ${newTicket.mask} from ${fromEmail} — "${subject}"`);
  }

  /**
   * Store the RFC Message-ID on the most recent post of a ticket.
   * Used so future In-Reply-To matches can find this post.
   */
  private async storeMessageIdOnLatestPost(ticketId: number, messageId: string): Promise<void> {
    const post = await this.prisma.ticketPost.findFirst({
      where: { ticketId },
      orderBy: { createdAt: 'desc' },
    });
    if (post) {
      await this.prisma.ticketPost.update({
        where: { id: post.id },
        data: { messageId },
      });
    }
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
