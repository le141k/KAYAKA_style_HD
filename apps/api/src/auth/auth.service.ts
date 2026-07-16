import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig, APP_CONFIG } from '../config/configuration';
import { TokenBlocklistService } from './token-blocklist.service';
import { SessionRevocationService } from './session-revocation.service';
import { verifyPassword, hashPassword } from './password.util';
import { type AuthStaff } from './auth.decorators';
import type { Permission } from './permissions';
import type { Staff, StaffGroup } from '@prisma/client';
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface LoginResult extends TokenPair {
  staff: AuthStaff;
}

/** Full staff record joined with group, used internally. */
type StaffWithGroup = Staff & { staffGroup: StaffGroup };

/** Token used to inject MailService optionally without creating a circular module dep. */
export const MAIL_SERVICE_TOKEN = Symbol('MAIL_SERVICE_TOKEN');

// D2 — per-account lockout thresholds (env-overridable). The per-IP throttler
// stops a single host hammering login; this stops a distributed brute-force from
// many IPs against one account.
const LOGIN_MAX_ATTEMPTS = Number(process.env['TELECOM_HD_LOGIN_MAX_ATTEMPTS']) || 5;
const LOGIN_LOCK_MINUTES = Number(process.env['TELECOM_HD_LOGIN_LOCK_MINUTES']) || 15;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly blocklist?: TokenBlocklistService,
    @Optional() private readonly sessions?: SessionRevocationService,
    @Optional()
    @Inject(MAIL_SERVICE_TOKEN)
    private readonly mailService?: { sendTemplate: (...args: unknown[]) => Promise<void> },
  ) {}

  /** Validate credentials; returns Staff+Group on success, throws otherwise. */
  async validateStaff(email: string, password: string): Promise<StaffWithGroup> {
    const staff = await this.prisma.staff.findUnique({
      where: { email },
      include: { staffGroup: true },
    });

    if (!staff || !staff.isEnabled) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // D2: reject while the account is locked, regardless of whether the supplied
    // password is correct — this is what blunts a distributed brute-force.
    if (staff.lockedUntil && staff.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException(
        'Account temporarily locked due to repeated failed login attempts. Try again later.',
      );
    }

    const ok = await verifyPassword(staff.passwordHash, password);
    if (!ok) {
      await this.registerFailedLogin(staff);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Successful auth clears any accumulated failure state.
    if (staff.failedLoginAttempts > 0 || staff.lockedUntil) {
      await this.prisma.staff.update({
        where: { id: staff.id },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
    }

    return staff;
  }

  /**
   * D2 — record a failed login: increment the counter and, once it crosses the
   * threshold, set `lockedUntil` and reset the counter so the next window starts
   * fresh after the lock expires. Best-effort: a DB hiccup here must not turn a
   * wrong password into a 500.
   */
  private async registerFailedLogin(staff: { id: number; failedLoginAttempts: number }): Promise<void> {
    const attempts = staff.failedLoginAttempts + 1;
    const locking = attempts >= LOGIN_MAX_ATTEMPTS;
    try {
      await this.prisma.staff.update({
        where: { id: staff.id },
        data: locking
          ? {
              failedLoginAttempts: 0,
              lockedUntil: new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000),
            }
          : { failedLoginAttempts: attempts },
      });
      if (locking) {
        this.logger.warn(`Staff ${staff.id} locked for ${LOGIN_LOCK_MINUTES}m after ${attempts} failures`);
      }
    } catch (err) {
      this.logger.error(`Failed to record login failure for staff ${staff.id}`, err as Error);
    }
  }

  /** Log in, issue tokens, persist hashed refresh token. */
  async login(email: string, password: string): Promise<LoginResult> {
    const staff = await this.validateStaff(email, password);
    const principal = this.buildPrincipal(staff);
    const tokens = await this.issueTokens(principal, staff.id);

    // Persist refresh token hash so we can rotate/revoke it
    await this.persistRefreshToken(staff.id, tokens.refreshToken);

    // Update lastLoginAt
    await this.prisma.staff.update({
      where: { id: staff.id },
      data: { lastLoginAt: new Date() },
    });

    this.logger.log(`Staff ${staff.email} logged in`);
    return { ...tokens, staff: principal };
  }

  /**
   * Rotate refresh token.
   * Verifies the incoming token, revokes it, and issues a fresh pair.
   */
  async refresh(rawRefreshToken: string): Promise<TokenPair> {
    // Decode header to get staffId from sub
    let payload: { sub: number; jti: string };
    try {
      payload = this.jwt.verify<{ sub: number; jti: string }>(rawRefreshToken, {
        secret: this.config.TELECOM_HD_JWT_REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Opportunistic cleanup of this staff's expired tokens (bounded, indexed) so the
    // scan below stays small. Fire-and-forget; failure must not block a valid refresh.
    void this.prisma.refreshToken
      .deleteMany({ where: { staffId: payload.sub, expiresAt: { lt: new Date() } } })
      .catch(() => undefined);

    // Active (non-revoked) stored tokens — the normal rotation path. Cap the scan
    // (newest first) so a staff with many sessions can't blow up the argon2 loop.
    const active = await this.prisma.refreshToken.findMany({
      where: { staffId: payload.sub, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    // Find matching token by verifying argon2 hash
    let matchedToken: (typeof active)[number] | undefined;
    for (const t of active) {
      if (new Date() > t.expiresAt) continue;
      const matches = await verifyPassword(t.tokenHash, rawRefreshToken);
      if (matches) {
        matchedToken = t;
        break;
      }
    }

    if (!matchedToken) {
      // Reuse detection: if the presented token matches one we already REVOKED
      // (and that hasn't expired), this is a replay of a rotated/stolen token.
      // Treat it as a compromise and revoke the entire token family for this staff.
      const revoked = await this.prisma.refreshToken.findMany({
        where: { staffId: payload.sub, NOT: { revokedAt: null }, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      for (const t of revoked) {
        if (await verifyPassword(t.tokenHash, rawRefreshToken)) {
          await this.prisma.refreshToken.updateMany({
            where: { staffId: payload.sub, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          this.logger.error(
            `SECURITY: refresh-token reuse detected for staff ${payload.sub} — all active sessions revoked`,
          );
          throw new UnauthorizedException('Refresh token reuse detected; all sessions have been revoked');
        }
      }
      throw new UnauthorizedException('Refresh token not found or expired');
    }

    // Revoke the used token (rotation)
    await this.prisma.refreshToken.update({
      where: { id: matchedToken.id },
      data: { revokedAt: new Date() },
    });

    // Load fresh staff record
    const staff = await this.prisma.staff.findUnique({
      where: { id: payload.sub },
      include: { staffGroup: true },
    });

    if (!staff || !staff.isEnabled) {
      throw new UnauthorizedException('Staff not found or disabled');
    }

    const principal = this.buildPrincipal(staff);
    const tokens = await this.issueTokens(principal, staff.id);
    await this.persistRefreshToken(staff.id, tokens.refreshToken);

    return tokens;
  }

  /**
   * Revoke all refresh tokens for the given staff member (logout).
   * The staffId comes from the verified JWT principal passed in by the controller.
   */
  async logout(staffId: number, accessJti?: string, accessExp?: number): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { staffId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Revoke the current access token too (jti blocklist) so it can't be used for
    // its remaining ~15 min after logout.
    if (accessJti && this.blocklist) {
      const ttl = accessExp
        ? accessExp - Math.floor(Date.now() / 1000)
        : this.config.TELECOM_HD_JWT_ACCESS_TTL;
      await this.blocklist.block(accessJti, ttl);
    }
    this.logger.log(`Staff ${staffId} logged out (tokens revoked)`);
  }

  // ─────────────────────────── Password reset ────────────────────────────────

  /**
   * Initiate a password-reset flow.
   * Always returns without error to avoid user enumeration — if the email does not
   * match any staff member, no email is sent but the response is identical.
   * Token is a 32-byte hex random; sha256 hash is stored (not argon2: the raw
   * token is a short-lived nonce so collision resistance is sufficient; using
   * sha256 keeps reset-password validation fast without a BCrypt/argon2 round).
   */
  async forgotPassword(email: string): Promise<void> {
    const staff = await this.prisma.staff.findUnique({ where: { email } });
    if (!staff || !staff.isEnabled) {
      // Silent no-op — do NOT leak whether the email exists.
      return;
    }

    // Invalidate any prior unused reset tokens for this staff so only the latest
    // link is valid (a "resend" shouldn't leave multiple live tokens).
    await this.prisma.passwordReset.updateMany({
      where: { staffId: staff.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.passwordReset.create({
      data: { staffId: staff.id, tokenHash, expiresAt },
    });

    const resetUrl = `${this.config.TELECOM_HD_PUBLIC_URL}/reset-password?token=${rawToken}`;

    // Non-blocking — if mail fails the user can request again
    if (this.mailService) {
      this.mailService
        .sendTemplate(email, 'password_reset', 'en', {
          firstName: staff.firstName,
          resetUrl,
          expiresInHours: '1',
        })
        .catch((err: unknown) =>
          this.logger.error(`Password-reset email failed for ${email}: ${String(err)}`),
        );
    } else {
      // Fallback: log the reset URL so dev/test environments without mail still work
      this.logger.log(`[DEV] Password reset link for ${email}: ${resetUrl}`);
    }
  }

  /**
   * Consume a password-reset token and set the new password.
   * Verifies: token sha256 matches a stored hash, not expired, not already used.
   * On success: updates passwordHash, marks token used, and revokes every
   * refresh/access session. The reset token is claimed conditionally inside the
   * transaction so two concurrent requests cannot both consume the same link.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const passwordHash = await hashPassword(newPassword);

    const staffId = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const record = await tx.passwordReset.findUnique({ where: { tokenHash } });
      if (!record || record.usedAt !== null || record.expiresAt <= now) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      // Claim the token with a predicate that remains true for exactly one
      // concurrent consumer. A second request observes count=0 after the first
      // transaction commits and receives the same generic 400 response.
      const claimed = await tx.passwordReset.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      await tx.staff.update({ where: { id: record.staffId }, data: { passwordHash } });
      await tx.refreshToken.updateMany({
        where: { staffId: record.staffId, revokedAt: null },
        data: { revokedAt: now },
      });
      return record.staffId;
    });

    // Refresh-token rows were updated atomically above. This second, central
    // revocation step adds the Redis access-token cutoff so an already-issued
    // access JWT cannot continue working for its remaining TTL.
    await this.sessions?.revokeAllForStaff(staffId);
    this.logger.log(`Password reset completed for staffId ${staffId}`);
  }

  // ─────────────────────── private helpers ───────────────────────

  /** Build the AuthStaff principal from a Staff+Group record. */
  buildPrincipal(staff: StaffWithGroup): AuthStaff {
    const firstName = staff.firstName ?? '';
    const lastName = staff.lastName ?? '';
    const fullName = [firstName, lastName].filter(Boolean).join(' ') || staff.email;
    return {
      staffId: staff.id,
      email: staff.email,
      isAdmin: staff.staffGroup.isAdmin,
      permissions: staff.staffGroup.permissions as Permission[],
      firstName,
      lastName,
      fullName,
    };
  }

  /** Issue access + refresh JWT pair. */
  private async issueTokens(principal: AuthStaff, staffId: number): Promise<TokenPair> {
    const jti = crypto.randomUUID();

    const accessToken = await this.jwt.signAsync(
      // Distinct jti on the access token so logout can revoke it via the blocklist.
      { ...principal, sub: staffId, jti: crypto.randomUUID(), issuedAtMs: Date.now() },
      {
        secret: this.config.TELECOM_HD_JWT_ACCESS_SECRET,
        expiresIn: this.config.TELECOM_HD_JWT_ACCESS_TTL,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: staffId, jti },
      {
        secret: this.config.TELECOM_HD_JWT_REFRESH_SECRET,
        expiresIn: this.config.TELECOM_HD_JWT_REFRESH_TTL,
      },
    );

    return { accessToken, refreshToken };
  }

  /** Persist a hashed copy of the raw refresh token. */
  private async persistRefreshToken(staffId: number, rawToken: string): Promise<void> {
    const tokenHash = await hashPassword(rawToken);
    const expiresAt = new Date(Date.now() + this.config.TELECOM_HD_JWT_REFRESH_TTL * 1000);

    await this.prisma.refreshToken.create({
      data: { staffId, tokenHash, expiresAt },
    });
  }
}
