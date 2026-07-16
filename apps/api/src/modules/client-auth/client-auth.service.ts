import {
  Injectable,
  Logger,
  UnauthorizedException,
  Inject,
  Optional,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { MAIL_SERVICE_TOKEN, type ResetMailer } from '../../auth/auth.service';

/** Verified client principal resolved from a session cookie. */
export interface ClientPrincipal {
  userId: number;
}

/** Single-use login link TTL: 15 minutes. */
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Client session TTL: 7 days. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Normalize an email for comparison: trim + lowercase. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Verified client (customer) authentication (GOAL_PUBLIC_SECURITY S2).
 *
 * Replaces "knowing an email" with a magic-link → single-use token → session cookie
 * flow, where every authorization decision is keyed on a stable `User.id`. Raw tokens
 * are never persisted (only SHA-256 hashes); responses never disclose account existence.
 */
@Injectable()
export class ClientAuthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClientAuthService.name);
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(MAIL_SERVICE_TOKEN) private readonly mailService?: ResetMailer,
  ) {}

  /** Schedule the idempotent hourly cleanup of expired auth material (S2-11). */
  onModuleInit(): void {
    if (this.config.NODE_ENV === 'test') return; // no timers under unit tests
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupExpired()
          .then((r) => {
            if (r.tokens || r.sessions) {
              this.logger.log(`client-auth cleanup removed ${r.tokens} tokens, ${r.sessions} sessions`);
            }
          })
          .catch((e) => this.logger.error(`client-auth cleanup failed: ${String(e)}`));
      },
      60 * 60 * 1000,
    );
    // Don't keep the event loop alive just for the cleanup timer.
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  /**
   * Resolve an email to exactly one owning `User.id`, or null if it is ambiguous /
   * unknown / owns no tickets. Ownership is by `User.id`; the email is only the lookup.
   */
  private async resolveUnambiguousOwner(normalizedEmail: string): Promise<number | null> {
    const userEmails = await this.prisma.userEmail.findMany({
      where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
      select: { userId: true },
    });
    const userIds = [...new Set(userEmails.map((u) => u.userId))];
    if (userIds.length !== 1) return null; // unknown or ambiguous → fail closed
    const userId = userIds[0]!;
    const ticketCount = await this.prisma.ticket.count({ where: { userId } });
    return ticketCount > 0 ? userId : null;
  }

  /**
   * Public request-link entry point. ALWAYS resolves without disclosing whether the
   * email exists; only queues a link when the address maps unambiguously to one user
   * who owns at least one ticket. Older unused tokens for that user are invalidated.
   */
  async requestLink(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const userId = await this.resolveUnambiguousOwner(email);
    if (userId === null) return; // generic response, no email, no enumeration

    await this.prisma.clientLoginToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = sha256(rawToken);
    const expiresAt = new Date(Date.now() + LOGIN_TOKEN_TTL_MS);
    const created = await this.prisma.clientLoginToken.create({
      data: { userId, tokenHash, email, expiresAt },
    });

    // Deliver the raw token in a URL fragment so it never reaches proxy/access logs (S2-5).
    const verifyUrl = `${this.config.TELECOM_HD_PUBLIC_URL}/client/verify#token=${rawToken}`;

    if (!this.mailService) {
      await this.invalidateToken(created.id);
      if (this.config.NODE_ENV === 'production') {
        this.logger.error('Client login mailer is not configured; no email sent');
      }
      return;
    }
    try {
      await this.mailService.sendTemplateStrict(email, 'client_login_link', 'en', {
        verifyUrl,
        expiresInMinutes: '15',
      });
    } catch {
      // Fail closed: invalidate the freshly issued token; stay generic; never log the link.
      await this.invalidateToken(created.id);
      this.logger.error(`Client login-link dispatch failed for userId ${userId}`);
    }
  }

  private async invalidateToken(id: string): Promise<void> {
    await this.prisma.clientLoginToken.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  /**
   * Atomically consume a single-use login token and open a client session.
   * Returns the raw session token (to be set as an HttpOnly cookie) — never stored raw.
   */
  async verify(rawToken: string): Promise<{ sessionToken: string; expiresAt: Date }> {
    const tokenHash = sha256(rawToken);

    // Conditional consume: exactly one caller flips usedAt from NULL for a live token.
    const consumed = await this.prisma.clientLoginToken.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException('Invalid or expired login link');
    }
    const token = await this.prisma.clientLoginToken.findUnique({ where: { tokenHash } });
    if (!token) {
      throw new UnauthorizedException('Invalid or expired login link');
    }

    const rawSession = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.clientSession.create({
      data: { userId: token.userId, tokenHash: sha256(rawSession), email: token.email, expiresAt },
    });
    this.logger.log(`Client session opened for userId ${token.userId}`);
    return { sessionToken: rawSession, expiresAt };
  }

  /** Resolve a raw session cookie to a client principal, or null if invalid. */
  async resolveSession(rawSession: string): Promise<ClientPrincipal | null> {
    const session = await this.prisma.clientSession.findUnique({
      where: { tokenHash: sha256(rawSession) },
    });
    if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
      return null;
    }
    // Best-effort last-seen bump (never blocks the request path).
    void this.prisma.clientSession
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    return { userId: session.userId };
  }

  /** Revoke the session identified by the raw cookie value. */
  async logout(rawSession: string): Promise<void> {
    await this.prisma.clientSession.updateMany({
      where: { tokenHash: sha256(rawSession), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Idempotent cleanup of expired/used login tokens and expired/revoked sessions (S2-11).
   * Returns aggregate counts only — never token values or customer emails.
   */
  async cleanupExpired(): Promise<{ tokens: number; sessions: number }> {
    const now = new Date();
    const tokens = await this.prisma.clientLoginToken.deleteMany({
      where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: now } }] },
    });
    const sessions = await this.prisma.clientSession.deleteMany({
      where: { OR: [{ revokedAt: { not: null } }, { expiresAt: { lt: now } }] },
    });
    return { tokens: tokens.count, sessions: sessions.count };
  }
}
