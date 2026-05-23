import { Injectable, Logger, Inject } from '@nestjs/common';
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
}

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
  ) {
    this.transporter = nodemailer.createTransport({
      host: config.TELECOM_HD_SMTP_HOST,
      port: config.TELECOM_HD_SMTP_PORT,
      secure: config.TELECOM_HD_SMTP_SECURE,
    });
  }

  /**
   * Send an outbound email.
   * Logs a warning and swallows the error to avoid crashing the ticket flow.
   */
  async send(opts: SendMailOptions): Promise<void> {
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
      });
      this.logger.debug(`Mail sent to ${opts.to}: ${opts.subject}`);
    } catch (err) {
      this.logger.error(`Failed to send mail to ${opts.to}: ${String(err)}`);
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
    await this.send({
      to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(opts?.cc?.length ? { cc: opts.cc } : {}),
      ...(opts?.bcc?.length ? { bcc: opts.bcc } : {}),
      ...(opts?.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
      ...(opts?.references ? { references: opts.references } : {}),
    });
  }
}
