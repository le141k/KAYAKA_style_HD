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

/**
 * Narrow reset-mail port. AuthService only needs to dispatch a security template and
 * be told (by a thrown error) when the hand-off failed. Bound to the real MailService
 * in AuthModule; left undefined only in pure unit tests.
 */
export interface ResetMailer {
  sendTemplateStrict(
    to: string | string[],
    templateKey: string,
    locale: string,
    vars: Record<string, string>,
  ): Promise<void>;
}

/** Token used to inject the reset mailer (MailService) into AuthService. */
export const MAIL_SERVICE_TOKEN = Symbol('MAIL_SERVICE_TOKEN');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly blocklist?: TokenBlocklistService,
    @Optional()
    @Inject(MAIL_SERVICE_TOKEN)
    private readonly mailService?: ResetMailer,
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

    const ok = await verifyPassword(staff.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return staff;
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

    // Active (non-revoked) stored tokens — the normal rotation path.
    const active = await this.prisma.refreshToken.findMany({
      where: { staffId: payload.sub, revokedAt: null },
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

    const reset = await this.prisma.passwordReset.create({
      data: { staffId: staff.id, tokenHash, expiresAt },
    });

    // Deliver the raw token in a URL FRAGMENT (#token=…) so it never lands in proxy
    // access logs or the Referer header when the reset page loads (S1-5).
    const resetUrl = `${this.config.TELECOM_HD_PUBLIC_URL}/reset-password#token=${rawToken}`;

    if (!this.mailService) {
      // No mailer wired. In the running app MailModule always provides one, so this
      // is a misconfiguration in production — fail closed by invalidating the token
      // and logging a diagnostic that NEVER contains the raw link.
      await this.invalidateReset(reset.id);
      if (this.config.NODE_ENV === 'production') {
        this.logger.error('Password-reset mailer is not configured; no email sent');
      }
      return;
    }

    try {
      // Strict dispatch throws if the mail cannot be enqueued/sent.
      await this.mailService.sendTemplateStrict(email, 'password_reset', 'en', {
        firstName: staff.firstName ?? '',
        resetUrl,
        expiresInHours: '1',
      });
    } catch {
      // Fail closed: invalidate the freshly-issued token so no live token dangles for
      // an email that never arrived. Keep the response generic (no enumeration) and
      // never log the raw link.
      await this.invalidateReset(reset.id);
      this.logger.error(`Password-reset dispatch failed for staffId ${staff.id}`);
    }
  }

  /** Invalidate a single still-unused reset token (idempotent). */
  private async invalidateReset(id: number): Promise<void> {
    await this.prisma.passwordReset.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  /**
   * Consume a password-reset token and set the new password.
   * Verifies: token sha256 matches a stored hash, not expired, not already used.
   * On success: updates passwordHash, marks token used, revokes all refresh tokens.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // Hash the new password BEFORE the race so the atomic consume→apply window stays
    // tiny (argon2 is deliberately slow).
    const passwordHash = await hashPassword(newPassword);

    // Atomically consume the token: only an unused, unexpired token is claimed, and
    // exactly one concurrent caller can flip usedAt from NULL to now. A second
    // (replayed or parallel) request updates zero rows and is rejected, so the
    // password changes exactly once. Replaces the prior find-then-update, which had
    // a check-to-write gap that let two requests both pass the check.
    const consumed = await this.prisma.passwordReset.updateMany({
      where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });

    if (consumed.count !== 1) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const record = await this.prisma.passwordReset.findUnique({ where: { tokenHash } });
    if (!record) {
      // Unreachable — we just consumed this exact hash — but fail safe.
      throw new BadRequestException('Invalid or expired reset token');
    }

    await this.prisma.$transaction([
      this.prisma.staff.update({
        where: { id: record.staffId },
        data: { passwordHash },
      }),
      // Revoke all active refresh tokens so existing sessions are invalidated.
      this.prisma.refreshToken.updateMany({
        where: { staffId: record.staffId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.logger.log(`Password reset completed for staffId ${record.staffId}`);
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
      { ...principal, sub: staffId, jti: crypto.randomUUID() },
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
