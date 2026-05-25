import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  from?: string;
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
}

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
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transporter: Transporter;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    // Optional so unit tests (and any non-DI construction) work without a queue —
    // when absent, send() delivers inline instead of enqueuing.
    @Optional() @InjectQueue('mail') private readonly mailQueue?: Queue,
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.TELECOM_HD_SMTP_HOST,
      port: config.TELECOM_HD_SMTP_PORT,
      secure: config.TELECOM_HD_SMTP_SECURE,
      // Authenticated relay in prod; MailHog/dev needs none. Only set auth when
      // both credentials are provided (otherwise nodemailer would force AUTH).
      ...(config.TELECOM_HD_SMTP_USER && config.TELECOM_HD_SMTP_PASSWORD
        ? { auth: { user: config.TELECOM_HD_SMTP_USER, pass: config.TELECOM_HD_SMTP_PASSWORD } }
        : {}),
    });
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
        removeOnFail: 100,
      });
    } catch (err) {
      // If enqueue fails (Redis down), don't lose the mail — deliver inline.
      this.logger.error(`Mail enqueue failed, delivering inline: ${String(err)}`);
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
      const toStr = Array.isArray(opts.to) ? opts.to.join(', ') : opts.to;
      const ccStr = opts.cc ? (Array.isArray(opts.cc) ? opts.cc.join(', ') : opts.cc) : undefined;
      const bccStr = opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc.join(', ') : opts.bcc) : undefined;
      await this.transporter.sendMail({
        from: opts.from ?? this.config.TELECOM_HD_MAIL_FROM,
        to: toStr,
        subject: opts.subject,
        html: opts.html,
        text: opts.text,
        ...(ccStr ? { cc: ccStr } : {}),
        ...(bccStr ? { bcc: bccStr } : {}),
        ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
        ...(opts.references ? { references: opts.references } : {}),
        ...(opts.autoSubmitted ? { headers: { 'Auto-Submitted': opts.autoSubmitted } } : {}),
      });
      this.logger.debug(`Mail sent to ${opts.to}: ${opts.subject}`);
    } catch (err) {
      this.logger.error(`Failed to send mail to ${opts.to}: ${String(err)}`);
      // When delivering from the BullMQ processor, rethrow so the job's retry/backoff
      // (attempts:3) actually fires. Inline fallback callers pass false so a send
      // failure never crashes the ticket flow.
      if (throwOnError) throw err instanceof Error ? err : new Error(String(err));
    }
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
}
