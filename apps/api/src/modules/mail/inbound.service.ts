import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Inject } from '@nestjs/common';
import type { ImapFlow, FetchMessageObject } from 'imapflow';
import { TicketsService } from '../tickets/tickets.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';

/** Ticket mask pattern used to thread inbound replies, e.g. TT-000042 */
const MASK_RE = /TT-\d{6,}/i;

/**
 * IMAP inbound mail service.
 *
 * When TELECOM_HD_IMAP_ENABLED=true (checked at runtime from the EmailQueue table),
 * this service polls each enabled IMAP queue and:
 *  1. Threads replies into existing tickets by matching the ticket mask in the subject.
 *  2. Creates new tickets from unthreaded messages via TicketsService.createTicket().
 *
 * The ImapFlow connection objects are stored in this.connections for cleanup.
 * Polling is driven by a simple setInterval (not BullMQ) to keep dependencies minimal.
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
    private readonly ticketsService: TicketsService,
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
    for (const queue of queues) {
      await this.connectQueue(queue.id, {
        host: queue.host,
        port: queue.port,
        secure: queue.useTls,
        auth: {
          user: queue.username,
          pass: queue.passwordEnc, // TODO: decrypt at-rest encrypted password
        },
      });
    }

    // Poll every 60 seconds
    this.pollHandle = setInterval(() => {
      void this.pollAll().catch((err: unknown) =>
        this.logger.error(`IMAP poll error: ${String(err)}`),
      );
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
   * Threads by ticket mask in subject; falls back to creating a new ticket.
   */
  private async processMessage(
    msg: FetchMessageObject,
    departmentId: number | undefined,
  ): Promise<void> {
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

    // Attempt to thread by mask
    const maskMatch = MASK_RE.exec(subject);
    if (maskMatch) {
      const mask = maskMatch[0].toUpperCase();
      try {
        const ticket = await this.ticketsService.getTicketByMask(mask);
        await this.ticketsService.reply(
          ticket.id,
          {
            contents: htmlBody ?? textBody,
            isHtml: !!htmlBody,
            isNote: false,
            isEmailed: true,
            isThirdParty: false,
            creationMode: 'EMAIL',
            ipAddress: '0.0.0.0',
          },
          // no staffId — user/system reply
        );
        this.logger.log(`IMAP: threaded reply to ${mask} from ${fromEmail}`);
        return;
      } catch {
        // Ticket not found → fall through to create new
        this.logger.warn(`IMAP: mask ${mask} in subject but ticket not found — creating new`);
      }
    }

    // Create new ticket
    const deptId = departmentId ?? (await this.defaultDeptId());
    await this.ticketsService.createTicket({
      subject,
      contents: htmlBody ?? textBody,
      isHtml: !!htmlBody,
      departmentId: deptId,
      requesterEmail: fromEmail,
      requesterName: fromName,
      creationMode: 'EMAIL',
      ipAddress: '0.0.0.0',
      tags: [],
      customFields: {},
    });
    this.logger.log(`IMAP: new ticket from ${fromEmail} — "${subject}"`);
  }

  private async defaultDeptId(): Promise<number> {
    const dept = await this.prisma.department.findFirst({ where: { isDefault: true } });
    return dept?.id ?? 1;
  }
}
