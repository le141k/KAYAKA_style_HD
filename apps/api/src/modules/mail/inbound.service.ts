import {
  Injectable,
  Logger,
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
 * TODO: persist per-queue UID watermark in the Setting table to avoid re-processing.
 */
@Injectable()
export class InboundMailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundMailService.name);
  private readonly connections: Map<number, ImapFlow> = new Map();
  private pollHandle: ReturnType<typeof setInterval> | null = null;

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
      // Fetch unseen messages
      for await (const msg of client.fetch('1:*', { envelope: true, source: true })) {
        await this.processMessage(msg, queue.departmentId ?? undefined);
      }
    } finally {
      lock.release();
    }
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
    const textBody = parsed.text ?? '';
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
      );
      emailAttachmentIds = uploaded.map((a) => a.id);
    }

    // RFC threading identifiers
    const incomingMessageId = parsed.messageId ?? undefined;
    const inReplyTo = parsed.inReplyTo ?? undefined;
    const references = (parsed.references as string[] | string | undefined) ?? undefined;

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
      try {
        const ticket = await this.ticketsService.getTicketByMask(mask);
        await this.ticketsService.reply(ticket.id, {
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
          await this.storeMessageIdOnLatestPost(ticket.id, incomingMessageId);
        }
        this.logger.log(`IMAP: threaded reply to ${mask} from ${fromEmail}`);
        return;
      } catch {
        // Ticket not found → fall through to create new
        this.logger.warn(`IMAP: mask ${mask} in subject but ticket not found — creating new`);
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

    // Send autoresponder
    await this.mailService.sendTemplate(fromEmail, 'autoresponder', 'en', {
      mask: newTicket.mask,
      subject: newTicket.subject,
      name: fromName,
    });

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
