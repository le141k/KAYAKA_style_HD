import {
  Injectable,
  Logger,
  Inject,
  Optional,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { randomUUID } from 'node:crypto';
import type { OutboundEmail, OutboundEmailState, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { StorageService } from '../attachments/storage.service';
import { MailAccessPolicy, type MailAccessActor } from './mail-access-policy.service';

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  replyTo?: string;
  cc?: string | string[];
  bcc?: string | string[];
  /** RFC threading: the Message-ID this mail replies to (so MUAs thread it). */
  inReplyTo?: string;
  /** RFC threading: the References chain. */
  references?: string | string[];
  /**
   * A5(i): RFC 3834 Auto-Submitted header. Set for machine-generated mail
   * (autoresponders, notifications) so a remote auto-responder won't ping-pong
   * with us. Human staff replies leave this unset.
   */
  autoSubmitted?: 'auto-replied' | 'auto-generated';
  /** A persisted RFC Message-ID for a durable outbox delivery. */
  messageId?: string;
  /** Immutable attachment snapshots are read from the upload volume by the worker. */
  attachments?: Array<{
    filename: string;
    contentType: string;
    path: string;
  }>;
}

/** BullMQ contains only this id — never email bodies, recipients or attachment bytes. */
export interface OutboundEmailJobData {
  outboundEmailId: string;
}

export interface OutboundDeliveryStatus {
  id: string;
  postId: number;
  state: OutboundEmailState;
  attempts: number;
  nextAttemptAt: Date | null;
  lastError: string | null;
  acceptedAt: Date | null;
  sentAt: Date | null;
}

const OUTBOX_LEASE_MS = 5 * 60_000;
const OUTBOX_HEARTBEAT_MS = 30_000;
const OUTBOX_RECOVERY_MS = 30_000;
const OUTBOX_RECOVERY_BATCH = 100;
const OUTBOX_MAX_ATTEMPTS = 5;

/** Safe projection for a staff ticket timeline — intentionally no recipients/BCC/body. */
export const OUTBOUND_STATUS_SELECT = {
  id: true,
  postId: true,
  state: true,
  attempts: true,
  nextAttemptAt: true,
  lastError: true,
  acceptedAt: true,
  sentAt: true,
} satisfies Prisma.OutboundEmailSelect;

/**
 * Template keys that are NOT machine-generated (a human composed them) — these
 * must NOT carry an Auto-Submitted header. Everything else sent via sendTemplate
 * is automated and is marked auto-generated for loop protection.
 */
const HUMAN_TEMPLATE_KEYS = new Set<string>(['ticket_user_reply']);

export interface RenderedTemplate {
  subject: string;
  html: string;
  text: string;
}

@Injectable()
export class MailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryRunning = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    // Optional so unit tests (and any non-DI construction) work without a queue —
    // when absent, send() delivers inline instead of enqueuing.
    @Optional() @InjectQueue('mail') private readonly mailQueue?: Queue,
    @Optional() private readonly storageService?: StorageService,
    // AuthModule owns a narrow reset-mail adapter without this policy; retry is
    // unavailable there and must fail closed if it is ever called.
    @Optional() private readonly mailAccess?: MailAccessPolicy,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.TELECOM_HD_SMTP_HOST,
      port: config.TELECOM_HD_SMTP_PORT,
      secure: config.TELECOM_HD_SMTP_SECURE,
      // Production port 587/25 must upgrade with STARTTLS; do not silently
      // deliver credentials or reset links after a downgrade/strip attack.
      requireTLS: config.NODE_ENV === 'production' && !config.TELECOM_HD_SMTP_SECURE,
      tls: { minVersion: 'TLSv1.2', servername: config.TELECOM_HD_SMTP_HOST },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
      // Authenticated relay in prod; MailHog/dev needs none. Only set auth when
      // both credentials are provided (otherwise nodemailer would force AUTH).
      ...(config.TELECOM_HD_SMTP_USER && config.TELECOM_HD_SMTP_PASSWORD
        ? { auth: { user: config.TELECOM_HD_SMTP_USER, pass: config.TELECOM_HD_SMTP_PASSWORD } }
        : {}),
    });
  }

  onModuleInit(): void {
    // PostgreSQL is authoritative. Redis is merely a low-latency wakeup path, so
    // every API/worker process scans eligible rows on startup and periodically.
    void this.recoverDurableOutbox();
    this.recoveryTimer = setInterval(() => void this.recoverDurableOutbox(), OUTBOX_RECOVERY_MS);
    this.recoveryTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
  }

  /** Exact configured sender snapshot used by transactional ticket replies. */
  getDefaultFromAddress(): string {
    return this.config.TELECOM_HD_MAIL_FROM;
  }

  /**
   * Add a durable outbox row to BullMQ as a best-effort wake-up only. Failure to
   * talk to Redis is intentionally not an SMTP fallback: the committed database
   * row is picked up by recoverDurableOutbox() after Redis returns, so a request
   * can never claim delivery just because an inline fallback happened to run.
   */
  async enqueueOutbound(outboundEmailId: string): Promise<void> {
    if (!this.mailQueue) {
      this.logger.warn(`Outbound email ${outboundEmailId} is durable but no mail worker queue is configured`);
      return;
    }
    try {
      await this.mailQueue.add('outbound', { outboundEmailId } satisfies OutboundEmailJobData, {
        jobId: `mail:${outboundEmailId}`,
        attempts: 1,
        removeOnComplete: true,
        // PostgreSQL holds every retry/diagnostic. Retaining a failed BullMQ
        // job with this deterministic id would block the recovery scan from
        // adding its next wake-up for up to a day, so discard it immediately.
        removeOnFail: true,
      });
    } catch (err) {
      // A duplicate job id is harmless: another process has already supplied the
      // wake-up. Any other Redis failure is also safe because DB recovery scans.
      this.logger.warn(
        `Outbound email ${outboundEmailId} remains queued after Redis enqueue failure (${this.errorKind(err)})`,
      );
    }
  }

  /** Scan durable mail rows after startup, Redis recovery and worker restarts. */
  async recoverDurableOutbox(): Promise<void> {
    if (this.recoveryRunning) return;
    this.recoveryRunning = true;
    try {
      const now = new Date();
      // A worker can die (or lose DB connectivity) after handing bytes to SMTP.
      // Its expired PROCESSING lease is therefore *not* evidence that a retry is
      // safe. Stop automatic delivery and make that uncertainty visible; an
      // operator may retry explicitly with the same Message-ID.
      await this.markStaleProcessingAmbiguous(now);
      const due = await this.prisma.outboundEmail.findMany({
        where: {
          OR: [{ state: 'QUEUED' }, { state: 'RETRY', nextAttemptAt: { lte: now } }],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: OUTBOX_RECOVERY_BATCH,
      });
      await Promise.all(due.map(({ id }) => this.enqueueOutbound(id)));
    } catch (err) {
      // Keep the timer alive; no email is lost because no row was modified here.
      this.logger.error(`Durable outbox recovery scan failed (${this.errorKind(err)})`);
    } finally {
      this.recoveryRunning = false;
    }
  }

  /**
   * Claim and deliver one durable row. It is safe for duplicate BullMQ jobs and
   * multiple API replicas: only the current lease token + leaseVersion can settle
   * the state after SMTP returns.
   */
  async processOutboundEmail(outboundEmailId: string): Promise<void> {
    const now = new Date();
    // A stale BullMQ job can arrive after the previous worker's lease expired.
    // Do not reclaim and transmit automatically: the prior SMTP attempt may have
    // succeeded even though its process never persisted SENT.
    if ((await this.markStaleProcessingAmbiguous(now, outboundEmailId)) > 0) return;

    const leaseOwner = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + OUTBOX_LEASE_MS);
    const claimed = await this.prisma.outboundEmail.updateMany({
      where: {
        id: outboundEmailId,
        OR: [{ state: 'QUEUED' }, { state: 'RETRY', nextAttemptAt: { lte: now } }],
      },
      data: {
        state: 'PROCESSING',
        attempts: { increment: 1 },
        leaseOwner,
        leaseExpiresAt,
        leaseVersion: { increment: 1 },
        // A previous diagnostic remains visible until this new attempt is actually
        // accepted or fails; never clear it during the claim itself.
      },
    });
    if (claimed.count !== 1) return;

    const outbound = await this.prisma.outboundEmail.findUnique({
      where: { id: outboundEmailId },
      include: { recipients: true, attachments: true },
    });
    if (
      !outbound ||
      outbound.state !== 'PROCESSING' ||
      outbound.leaseOwner !== leaseOwner ||
      outbound.leaseVersion < 1
    ) {
      return;
    }

    const heartbeat = setInterval(
      () => void this.extendLease(outbound.id, leaseOwner, outbound.leaseVersion),
      OUTBOX_HEARTBEAT_MS,
    );
    heartbeat.unref?.();
    let smtpAccepted = false;
    try {
      const options = this.toSendMailOptions(outbound);
      const response = await this.deliverOrThrow(options);
      smtpAccepted = true;
      await this.markSent(outbound, leaseOwner, response);
    } catch (err) {
      // A failure *after* nodemailer resolved is a database/fence persistence
      // problem, not a failed SMTP attempt. Retrying it automatically could mail a
      // customer twice, so make the uncertainty explicit and require operator
      // confirmation with the same Message-ID.
      if (smtpAccepted) await this.markAmbiguousAfterSmtpAcceptance(outbound, leaseOwner);
      else await this.recordDeliveryFailure(outbound, leaseOwner, err);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** Operator retry preserves the original Message-ID and snapshots. */
  async retryOutboundEmail(
    outboundEmailId: string,
    actor: MailAccessActor,
  ): Promise<OutboundDeliveryStatus | null> {
    if (!this.mailAccess) throw new ServiceUnavailableException('Mail operator authorization unavailable');
    const scope = await this.mailAccess.resolveScope(actor);
    const scopedWhere: Prisma.OutboundEmailWhereInput = scope.unrestricted
      ? { id: outboundEmailId }
      : {
          AND: [{ id: outboundEmailId }, { ticket: { is: this.mailAccess.ticketWhereForScope(scope) } }],
        };
    const result = await this.prisma.$transaction(async (tx) => {
      const row = await tx.outboundEmail.findFirst({
        where: scopedWhere,
        select: { id: true, ticketId: true, postId: true, state: true },
      });
      if (!row || row.state === 'SENT') return null;
      const changed = await tx.outboundEmail.updateMany({
        where: {
          AND: [scopedWhere, { state: { in: ['FAILED', 'AMBIGUOUS', 'RETRY'] } }],
        },
        data: {
          state: 'QUEUED',
          nextAttemptAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
        },
      });
      if (changed.count !== 1) return null;
      await tx.ticketAuditLog.create({
        data: {
          ticketId: row.ticketId,
          staffId: actor.staffId,
          actorType: 'STAFF',
          action: 'OUTBOUND_RETRY',
          field: 'outboundEmailId',
          newValue: row.id,
        },
      });
      return tx.outboundEmail.findFirst({
        where: scopedWhere,
        select: OUTBOUND_STATUS_SELECT,
      });
    });
    if (result) await this.enqueueOutbound(outboundEmailId);
    return result;
  }

  /**
   * Enqueue an outbound email onto the 'mail' BullMQ queue so SMTP latency never
   * blocks the HTTP request / processor loop. Falls back to inline delivery when
   * no queue is wired (unit tests). Retries with backoff are configured on the job.
   */
  async send(opts: SendMailOptions): Promise<void> {
    if (!this.mailQueue) {
      await this.deliver(opts);
      return;
    }
    try {
      await this.mailQueue.add('send', opts, {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: { age: 86_400, count: 100 },
      });
    } catch {
      // If enqueue fails (Redis down), don't lose the mail — deliver inline.
      this.logger.error('Mail enqueue failed; delivering inline');
      await this.deliver(opts);
    }
  }

  /**
   * Actually deliver an email via SMTP. Called by the MailProcessor (off the
   * critical path) or inline as a fallback. Logs and swallows errors so a send
   * failure never crashes the ticket flow.
   */
  async deliver(opts: SendMailOptions, throwOnError = false): Promise<void> {
    try {
      await this.deliverOrThrow(opts);
      this.logger.debug('Mail delivered');
    } catch (err) {
      this.logger.error(`Mail delivery failed (${err instanceof Error ? err.name : 'UnknownError'})`);
      // When delivering from the BullMQ processor, rethrow so the job's retry/backoff
      // (attempts:3) actually fires. Inline fallback callers pass false so a send
      // failure never crashes the ticket flow.
      if (throwOnError) throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /** SMTP delivery that PROPAGATES failures (used by the strict security path). */
  private async deliverOrThrow(opts: SendMailOptions): Promise<{ messageId?: string; response?: string }> {
    const toStr = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;
    const ccStr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc.join(', ') : opts.cc) : undefined;
    const bccStr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc.join(', ') : opts.bcc) : undefined;
    const result = await this.transporter.sendMail({
      from: opts.from ?? this.config.TELECOM_HD_MAIL_FROM,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      to: toStr,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
      ...(ccStr ? { cc: ccStr } : {}),
      ...(bccStr ? { bcc: bccStr } : {}),
      ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      ...(opts.references ? { references: opts.references } : {}),
      ...(opts.messageId ? { messageId: opts.messageId } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      // A5 mail-loop/bounce protection (preserved from main): stamp Auto-Submitted so
      // downstream mailers don't auto-reply to our own notifications.
      ...(opts.autoSubmitted ? { headers: { 'Auto-Submitted': opts.autoSubmitted } } : {}),
    });
    return {
      ...(typeof result.messageId === 'string' ? { messageId: result.messageId } : {}),
      ...(typeof result.response === 'string' ? { response: result.response } : {}),
    };
  }

  /**
   * Render and send a security-critical template (password reset, magic link),
   * PROPAGATING any SMTP failure instead of swallowing it (GOAL_PUBLIC_SECURITY
   * S1-4). The caller relies on this to fail closed — invalidating the issued token
   * when the mail cannot be handed off — so a live token whose email silently
   * vanished never dangles. Never logs the rendered body/subject (they carry the link).
   */
  async sendTemplateStrict(
    to: string | string[],
    templateKey: string,
    locale: string,
    vars: Record<string, string>,
  ): Promise<void> {
    const rendered = await this.renderTemplate(templateKey, locale, vars);
    const opts: SendMailOptions = {
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };
    // Never serialize a live reset/magic-link URL into BullMQ/Redis. Security mail
    // is delivered inline with bounded SMTP timeouts; callers invalidate the token
    // and return the same generic response if delivery fails.
    await this.deliverOrThrow(opts);
  }

  /**
   * Load and render an email template from the database.
   * Variables are substituted using a simple {{key}} syntax.
   *
   * @param key    Template key (e.g. 'ticket_user_reply', 'autoresponder')
   * @param locale Locale code, defaults to 'en'; falls back to 'en' if not found
   * @param vars   Record of {{key}} → value replacements
   */
  async renderTemplate(key: string, locale: string, vars: Record<string, string>): Promise<RenderedTemplate> {
    // Try requested locale first, then fall back to English
    let tpl = await this.prisma.emailTemplate.findUnique({
      where: { key_locale: { key, locale } },
    });

    if (!tpl && locale !== 'en') {
      tpl = await this.prisma.emailTemplate.findUnique({
        where: { key_locale: { key, locale: 'en' } },
      });
    }

    if (!tpl) {
      this.logger.warn(`Email template "${key}" (${locale}) not found; sending plain fallback`);
      return {
        subject: vars['subject'] ?? key,
        html: JSON.stringify(vars),
        text: JSON.stringify(vars),
      };
    }

    const replace = (str: string): string => str.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? '');

    return {
      subject: replace(tpl.subject),
      html: replace(tpl.htmlBody),
      text: replace(tpl.textBody),
    };
  }

  /**
   * Render a human staff reply only when its approved template exists. The generic
   * renderTemplate fallback intentionally remains for legacy notifications, but a
   * durable customer email must never commit a JSON-shaped emergency body and then
   * be reported as SMTP-delivered.
   */
  async renderTemplateRequired(
    key: string,
    locale: string,
    vars: Record<string, string>,
  ): Promise<RenderedTemplate> {
    let tpl = await this.prisma.emailTemplate.findUnique({
      where: { key_locale: { key, locale } },
    });
    if (!tpl && locale !== 'en') {
      tpl = await this.prisma.emailTemplate.findUnique({
        where: { key_locale: { key, locale: 'en' } },
      });
    }
    if (!tpl) throw new Error(`Required email template "${key}" (${locale}) is not configured`);
    const replace = (str: string): string =>
      str.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => vars[name] ?? '');
    return { subject: replace(tpl.subject), html: replace(tpl.htmlBody), text: replace(tpl.textBody) };
  }

  /**
   * Convenience: render and send a template email.
   * Optionally pass cc/bcc arrays for CC/BCC recipients.
   */
  async sendTemplate(
    to: string | string[],
    templateKey: string,
    locale: string,
    vars: Record<string, string>,
    opts?: { cc?: string[]; bcc?: string[]; inReplyTo?: string; references?: string | string[] },
  ): Promise<void> {
    const rendered = await this.renderTemplate(templateKey, locale, vars);
    // A5(i): autoresponder is an auto-reply; other templated mail (notifications,
    // SLA breach, auto-close) is auto-generated; human staff replies are neither.
    const autoSubmitted = HUMAN_TEMPLATE_KEYS.has(templateKey)
      ? undefined
      : templateKey === 'autoresponder'
        ? ('auto-replied' as const)
        : ('auto-generated' as const);
    await this.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(autoSubmitted ? { autoSubmitted } : {}),
      ...(opts?.cc?.length ? { cc: opts.cc } : {}),
      ...(opts?.bcc?.length ? { bcc: opts.bcc } : {}),
      ...(opts?.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      ...(opts?.references ? { references: opts.references } : {}),
    });
  }

  private toSendMailOptions(
    outbound: OutboundEmail & {
      recipients: Array<{ email: string; role: 'TO' | 'CC' | 'BCC' }>;
      attachments: Array<{
        fileName: string;
        mimeType: string;
        storageKey: string;
      }>;
    },
  ): SendMailOptions {
    if (!this.storageService && outbound.attachments.length > 0) {
      // This is a deployment wiring error, not a reason to send an incomplete
      // email. recordDeliveryFailure() will expose a retryable safe diagnostic.
      throw new Error('Outbound attachment storage is unavailable');
    }
    const recipientsByRole = (role: 'TO' | 'CC' | 'BCC') =>
      outbound.recipients.filter((recipient) => recipient.role === role).map((recipient) => recipient.email);
    const to = recipientsByRole('TO');
    if (to.length === 0) throw new Error('Outbound email has no To recipient');
    const cc = recipientsByRole('CC');
    const bcc = recipientsByRole('BCC');
    return {
      from: outbound.fromAddress,
      ...(outbound.replyToAddress ? { replyTo: outbound.replyToAddress } : {}),
      to,
      subject: outbound.subject,
      html: outbound.htmlBody,
      text: outbound.textBody,
      messageId: outbound.messageId,
      ...(outbound.inReplyTo ? { inReplyTo: outbound.inReplyTo } : {}),
      ...(outbound.references.length ? { references: outbound.references } : {}),
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      ...(outbound.attachments.length
        ? {
            attachments: outbound.attachments.map((attachment) => ({
              filename: attachment.fileName,
              contentType: attachment.mimeType,
              path: this.storageService!.pathForKey(attachment.storageKey),
            })),
          }
        : {}),
    };
  }

  private async extendLease(id: string, leaseOwner: string, leaseVersion: number): Promise<void> {
    try {
      const changed = await this.prisma.outboundEmail.updateMany({
        where: {
          id,
          state: 'PROCESSING',
          leaseOwner,
          leaseVersion,
        },
        data: { leaseExpiresAt: new Date(Date.now() + OUTBOX_LEASE_MS) },
      });
      if (changed.count !== 1) {
        this.logger.warn(`Outbound email ${id} lost its delivery lease before heartbeat`);
      }
    } catch (err) {
      // Timers must never create an unhandled rejection. A later stale-lease scan
      // will conservatively move the row to AMBIGUOUS instead of re-sending it.
      this.logger.error(`Outbound email ${id} lease heartbeat failed (${this.errorKind(err)})`);
    }
  }

  /**
   * An expired delivery lease is an unknown SMTP outcome, not a retry permit.
   * This is deliberately a CAS on PROCESSING + expiry: a live heartbeat or a
   * completed settlement wins cleanly, while a dead worker can never cause an
   * automatic duplicate customer email.
   */
  private async markStaleProcessingAmbiguous(now: Date, outboundEmailId?: string): Promise<number> {
    const changed = await this.prisma.outboundEmail.updateMany({
      where: {
        ...(outboundEmailId ? { id: outboundEmailId } : {}),
        state: 'PROCESSING',
        OR: [{ leaseExpiresAt: { lt: now } }, { leaseExpiresAt: null }],
      },
      data: {
        state: 'AMBIGUOUS',
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastError: 'Delivery worker lease expired; SMTP outcome is unknown',
      },
    });
    if (changed.count > 0) {
      this.logger.error(
        `${changed.count} durable outbound email(s) became AMBIGUOUS after an expired worker lease`,
      );
    }
    return changed.count;
  }

  private async markSent(
    outbound: OutboundEmail,
    leaseOwner: string,
    response: { messageId?: string; response?: string },
  ): Promise<boolean> {
    const now = new Date();
    const providerResponse = this.sanitizeProviderResponse(response.response ?? response.messageId);
    const settled = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.outboundEmail.updateMany({
        where: {
          id: outbound.id,
          state: 'PROCESSING',
          leaseOwner,
          leaseVersion: outbound.leaseVersion,
        },
        data: {
          state: 'SENT',
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastError: null,
          providerResponse,
          acceptedAt: now,
          sentAt: now,
        },
      });
      if (changed.count !== 1) return false;
      // The timeline's legacy boolean is a server-owned projection of SMTP
      // acceptance. Never set it when the post was merely queued.
      await tx.ticketPost.updateMany({ where: { id: outbound.postId }, data: { isEmailed: true } });
      // First-response SLA is also a delivery fact, not a compose/queue fact.
      // Conditional update avoids overwriting the first successful staff reply
      // when multiple queued replies complete out of order.
      await tx.ticket.updateMany({
        where: { id: outbound.ticketId, firstResponseAt: null },
        data: { firstResponseAt: now },
      });
      return true;
    });
    if (!settled) {
      // SMTP may have accepted the message, but this worker lost its fence. Do not
      // falsely write SENT; the current lease owner/operator sees the durable state.
      this.logger.error(`Outbound email ${outbound.id} was accepted by SMTP after its lease was lost`);
    }
    return settled;
  }

  private async markAmbiguousAfterSmtpAcceptance(outbound: OutboundEmail, leaseOwner: string): Promise<void> {
    try {
      const changed = await this.prisma.outboundEmail.updateMany({
        where: {
          id: outbound.id,
          state: 'PROCESSING',
          leaseOwner,
          leaseVersion: outbound.leaseVersion,
        },
        data: {
          state: 'AMBIGUOUS',
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          lastError: 'SMTP accepted but delivery state could not be persisted',
        },
      });
      if (changed.count !== 1) {
        this.logger.error(
          `Outbound email ${outbound.id} accepted SMTP but its lease was lost before ambiguity mark`,
        );
      }
    } catch (markErr) {
      // If PostgreSQL is unavailable even for the ambiguity write, leave the
      // fenced PROCESSING row intact. It will be visible as a stale lease rather
      // than being silently reported SENT; do not attempt an automatic SMTP retry.
      this.logger.error(
        `Outbound email ${outbound.id} accepted SMTP and its ambiguity mark failed (${this.errorKind(markErr)})`,
      );
    }
  }

  private async recordDeliveryFailure(
    outbound: OutboundEmail,
    leaseOwner: string,
    err: unknown,
  ): Promise<void> {
    const outcome = this.classifyFailure(err, outbound.attempts);
    const changed = await this.prisma.outboundEmail.updateMany({
      where: {
        id: outbound.id,
        state: 'PROCESSING',
        leaseOwner,
        leaseVersion: outbound.leaseVersion,
      },
      data: {
        state: outcome.state,
        leaseOwner: null,
        leaseExpiresAt: null,
        nextAttemptAt: outcome.nextAttemptAt,
        lastError: this.sanitizeFailure(err),
      },
    });
    if (changed.count === 1) {
      this.logger.warn(`Outbound email ${outbound.id} is now ${outcome.state} (${this.errorKind(err)})`);
    } else {
      // Never overwrite a current lease's truth after an uncertain SMTP exception.
      this.logger.error(`Outbound email ${outbound.id} failed after its delivery lease was lost`);
    }
  }

  private classifyFailure(
    err: unknown,
    attempts: number,
  ): { state: 'RETRY' | 'FAILED' | 'AMBIGUOUS'; nextAttemptAt: Date | null } {
    const error = err as { code?: unknown; responseCode?: unknown; message?: unknown };
    const responseCode = typeof error?.responseCode === 'number' ? error.responseCode : undefined;
    if (responseCode !== undefined) {
      if (responseCode >= 500) return { state: 'FAILED', nextAttemptAt: null };
      if (responseCode >= 400) {
        if (attempts >= OUTBOX_MAX_ATTEMPTS) return { state: 'FAILED', nextAttemptAt: null };
        return { state: 'RETRY', nextAttemptAt: this.retryAt(attempts) };
      }
    }
    const code = typeof error?.code === 'string' ? error.code.toUpperCase() : '';
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    // A network disconnect/timeout can happen after the relay accepted DATA. Such
    // outcomes must be operator-visible rather than automatically retried as SENT.
    if (
      ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ESOCKET', 'EPIPE', 'ECONNREFUSED'].includes(code) ||
      /timed?\s*out|connection\s*(reset|closed|lost)|socket\s*(hang|closed)/.test(message)
    ) {
      return { state: 'AMBIGUOUS', nextAttemptAt: null };
    }
    // Unexpected/local errors are not evidence of SMTP acceptance. Retry a
    // bounded number of times; the persisted Message-ID remains stable.
    if (attempts >= OUTBOX_MAX_ATTEMPTS) return { state: 'FAILED', nextAttemptAt: null };
    return { state: 'RETRY', nextAttemptAt: this.retryAt(attempts) };
  }

  private retryAt(attempts: number): Date {
    const delayMs = Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
    return new Date(Date.now() + delayMs);
  }

  private sanitizeFailure(err: unknown): string {
    const error = err as { responseCode?: unknown; code?: unknown; message?: unknown };
    const responseCode = typeof error?.responseCode === 'number' ? `SMTP ${error.responseCode}` : '';
    const code = typeof error?.code === 'string' ? error.code.replace(/[^A-Z0-9_-]/gi, '').slice(0, 48) : '';
    const kind = responseCode || code || this.errorKind(err);
    // Deliberately avoid err.message: SMTP library errors may repeat recipient
    // headers, envelope addresses or relay-specific detail. The operator has a
    // stable category without secret/PII leakage.
    return `Delivery failed: ${kind}`.slice(0, 256);
  }

  private sanitizeProviderResponse(value: string | undefined): string | null {
    if (!value) return null;
    // Relay responses often include the accepted recipient. Do not project that
    // into the ticket timeline; retain only a bounded protocol-status fragment.
    const status = /\b([245]\d\d)\b/.exec(value)?.[1];
    return status ? `SMTP ${status} accepted` : 'SMTP accepted';
  }

  private errorKind(err: unknown): string {
    if (err && typeof err === 'object') {
      const candidate = err as { name?: unknown; code?: unknown };
      if (typeof candidate.code === 'string') return candidate.code.slice(0, 64);
      if (typeof candidate.name === 'string') return candidate.name.slice(0, 64);
    }
    return 'UnknownError';
  }
}
