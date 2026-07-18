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
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { MAIL_SERVICE_TOKEN, type ResetMailer } from '../../auth/auth.service';
// Re-exported for back-compat with existing importers; canonical home is common/email.util.
export { normalizeEmail } from '../../common/email.util';
import { normalizeEmail } from '../../common/email.util';
import { lockClientIdentity } from '../../common/client-auth-lock';

/** Verified client principal resolved from a session cookie. */
export interface ClientPrincipal {
  userId: number;
}

/** Single-use login link TTL: 15 minutes. */
const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Per-owner magic-link mail-bomb cap: at most N links issued per window. */
const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;
const MAGIC_LINK_MAX_PER_WINDOW = 3;
/** Client session TTL: 7 days. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
interface ResolvedOwner {
  userId: number;
  clientAuthVersion: number;
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
  private async resolveUnambiguousOwner(
    db: PrismaService | Prisma.TransactionClient,
    normalizedEmail: string,
  ): Promise<ResolvedOwner | null> {
    // Query every legacy row by the DB's canonical expression. A Prisma insensitive
    // equality does not trim stored values and could select the normalized row while
    // missing a whitespace variant owned by somebody else. Until the invariant migration
    // is installed, that would turn dirty data into an account-takeover ambiguity.
    const userEmails = await db.$queryRaw<{ userId: number }[]>`
      SELECT "userId"
      FROM "UserEmail"
      -- Keep the trim characters a SQL constant (rather than a bind parameter) so Postgres
      -- can use UserEmail_email_normalized_key for this public request path.
      WHERE lower(btrim("email", E' \\t\\n\\r\\f\\x0B')) = ${normalizedEmail}
    `;
    const userIds = [...new Set(userEmails.map((u) => u.userId))];
    if (userIds.length !== 1) return null; // unknown or ambiguous → fail closed
    const userId = userIds[0]!;
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { isEnabled: true, clientAuthVersion: true },
    });
    if (!user || !user.isEnabled) return null;
    const ticketCount = await db.ticket.count({ where: { userId } });
    return ticketCount > 0 ? { userId, clientAuthVersion: user.clientAuthVersion } : null;
  }

  /**
   * Public request-link entry point. ALWAYS resolves without disclosing whether the
   * email exists; only queues a link when the address maps unambiguously to one user
   * who owns at least one ticket. Older unused tokens for that user are invalidated.
   */
  async requestLink(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const initialOwner = await this.resolveUnambiguousOwner(this.prisma, email);
    if (initialOwner === null) return; // generic response, no email, no enumeration

    // Serialize all issuance for one owner. The second in-transaction resolution closes
    // the gap where an email is removed/reassigned after the public lookup but before create.
    // It also makes the per-owner cap and invalidate-old/create-new sequence race-safe.
    const issued = await this.prisma.$transaction(async (tx) => {
      await lockClientIdentity(tx, initialOwner.userId);
      const owner = await this.resolveUnambiguousOwner(tx, email);
      if (!owner || owner.userId !== initialOwner.userId) return null;

      const recentLinks = await tx.clientLoginToken.count({
        where: {
          userId: owner.userId,
          createdAt: { gt: new Date(Date.now() - MAGIC_LINK_WINDOW_MS) },
        },
      });
      if (recentLinks >= MAGIC_LINK_MAX_PER_WINDOW) return null;

      const now = new Date();
      await tx.clientLoginToken.updateMany({
        where: { userId: owner.userId, usedAt: null },
        data: { usedAt: now },
      });

      const rawToken = randomBytes(32).toString('hex');
      const created = await tx.clientLoginToken.create({
        data: {
          userId: owner.userId,
          clientAuthVersion: owner.clientAuthVersion,
          tokenHash: sha256(rawToken),
          email,
          expiresAt: new Date(Date.now() + LOGIN_TOKEN_TTL_MS),
        },
      });
      return { id: created.id, rawToken, userId: owner.userId };
    });
    if (!issued) return;

    // Deliver the raw token in a URL fragment so it never reaches proxy/access logs (S2-5).
    // Path is `/verify` — the (client) Next.js route group serves at the root, matching the
    // `/reset-password` precedent (NOT `/client/verify`, which would 404).
    const verifyUrl = `${this.config.TELECOM_HD_PUBLIC_URL}/verify#token=${issued.rawToken}`;

    if (!this.mailService) {
      await this.invalidateToken(issued.id);
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
      await this.invalidateToken(issued.id);
      this.logger.error(`Client login-link dispatch failed for userId ${issued.userId}`);
    }
  }

  /**
   * Detach identity lookup, token issuance and SMTP from the public response path.
   * Every caller receives the same immediate 202 after challenge/quota checks; a
   * known owner can no longer be inferred from database or mail latency.
   */
  queueRequestLink(rawEmail: string): void {
    void this.requestLink(rawEmail).catch(() => {
      this.logger.error('Client login-link background dispatch failed');
    });
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
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.clientLoginToken.findUnique({
        where: { tokenHash },
        select: { userId: true },
      });
      if (!candidate) throw new UnauthorizedException('Invalid or expired login link');

      // User identity mutations take the same lock, so a disable/email removal cannot
      // interleave between the final version check and session creation.
      await lockClientIdentity(tx, candidate.userId);
      const token = await tx.clientLoginToken.findUnique({
        where: { tokenHash },
        include: { user: { select: { isEnabled: true, clientAuthVersion: true } } },
      });
      const now = new Date();
      if (
        !token ||
        token.usedAt !== null ||
        token.expiresAt <= now ||
        !token.user.isEnabled ||
        token.clientAuthVersion !== token.user.clientAuthVersion
      ) {
        throw new UnauthorizedException('Invalid or expired login link');
      }

      const consumed = await tx.clientLoginToken.updateMany({
        where: {
          id: token.id,
          usedAt: null,
          expiresAt: { gt: now },
          clientAuthVersion: token.user.clientAuthVersion,
        },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new UnauthorizedException('Invalid or expired login link');
      }

      const rawSession = randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
      await tx.clientSession.create({
        data: {
          userId: token.userId,
          clientAuthVersion: token.clientAuthVersion,
          tokenHash: sha256(rawSession),
          email: token.email,
          expiresAt,
        },
      });
      this.logger.log(`Client session opened for userId ${token.userId}`);
      return { sessionToken: rawSession, expiresAt };
    });
  }

  /** Resolve a raw session cookie to a client principal, or null if invalid. */
  async resolveSession(rawSession: string): Promise<ClientPrincipal | null> {
    const session = await this.prisma.clientSession.findUnique({
      where: { tokenHash: sha256(rawSession) },
      include: { user: { select: { isEnabled: true, clientAuthVersion: true } } },
    });
    if (!session || session.revokedAt !== null || session.expiresAt < new Date()) {
      return null;
    }
    // A user disabled or identity-changed AFTER login loses access immediately, even though
    // the 7-day cookie has not expired: both enabled state and the durable version must match.
    if (
      !session.user ||
      !session.user.isEnabled ||
      session.clientAuthVersion !== session.user.clientAuthVersion
    ) {
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
