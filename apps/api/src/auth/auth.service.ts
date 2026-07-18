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
import { LoginThrottleService } from './login-throttle.service';
import { verifyPassword, hashPassword } from './password.util';
import { type AuthStaff } from './auth.decorators';
import type { Permission } from './permissions';
import type { Staff, StaffGroup } from '@prisma/client';
export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export type RefreshResult =
  | { accessToken: string; refreshToken: string; refreshRotated: true }
  | { accessToken: string; refreshRotated: false };

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

/**
 * Grace window for refresh rotation (S3-3). If a token's jti is found already-revoked
 * within this window of now, we treat it as a benign concurrent double-submit (the
 * winner just rotated) and fail the loser without revoking the family. Beyond it, a
 * presented already-rotated token is a genuine replay → revoke the whole family.
 */
const REFRESH_ROTATION_GRACE_MS = 10_000;

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
    private readonly mailService?: ResetMailer,
    @Optional() private readonly loginThrottle?: LoginThrottleService,
  ) {}

  /**
   * A throwaway argon2id hash (same cost params as real hashes, since both come from
   * `hashPassword`) used only to equalize login timing. Cached after first use.
   */
  private decoyHash?: string;
  private async getDecoyHash(): Promise<string> {
    if (!this.decoyHash) {
      this.decoyHash = await hashPassword(randomBytes(16).toString('hex'));
    }
    return this.decoyHash;
  }

  /** Validate credentials; returns Staff+Group on success, throws otherwise. */
  async validateStaff(email: string, password: string): Promise<StaffWithGroup> {
    const staff = await this.prisma.staff.findUnique({
      where: { email },
      include: { staffGroup: true },
    });

    if (!staff || !staff.isEnabled) {
      // Anti-enumeration: a missing OR disabled account must cost the same as a wrong
      // password. Verify against a decoy hash so both branches pay one argon2 verify —
      // otherwise the argon2 delta is a timing oracle for "does this email exist?".
      await verifyPassword(await this.getDecoyHash(), password);
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await verifyPassword(staff.passwordHash, password);
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return staff;
  }

  /** Log in, issue tokens, persist hashed refresh token. */
  async login(email: string, password: string, ip?: string): Promise<LoginResult> {
    // Login-abuse throttle (S3-7): reject over-threshold (IP + email) BEFORE hashing,
    // record failures, clear on success. Never locks the account (per-IP key, expires).
    if (this.loginThrottle) await this.loginThrottle.assertNotThrottled(email, ip);
    let staff: StaffWithGroup;
    try {
      staff = await this.validateStaff(email, password);
    } catch (err) {
      if (this.loginThrottle) await this.loginThrottle.recordFailure(email, ip);
      throw err;
    }
    if (this.loginThrottle) await this.loginThrottle.clear(email, ip);

    const principal = this.buildPrincipal(staff);
    // A fresh login starts a new rotation family.
    const familyId = crypto.randomUUID();
    const tokens = await this.issueTokens(principal, staff.id, staff.authVersion, familyId);

    // Persist refresh token hash so we can rotate/revoke it
    await this.persistRefreshToken(
      staff.id,
      tokens.refreshToken,
      tokens.refreshJti,
      familyId,
      staff.authVersion,
    );

    // Update lastLoginAt
    await this.prisma.staff.update({
      where: { id: staff.id },
      data: { lastLoginAt: new Date() },
    });

    this.logger.log(`Staff ${staff.id} logged in`);
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, staff: principal };
  }

  /**
   * Rotate refresh token (S3-3).
   * Looks up EXACTLY ONE stored row by the token's opaque `jti` (no Argon2 scan),
   * verifies its hash, and rotates it with a conditional CAS. Exactly one concurrent
   * caller wins; a genuine later replay of an already-rotated token revokes the family.
   */
  async refresh(rawRefreshToken: string): Promise<RefreshResult> {
    let payload: { sub: number; jti: string; fid?: string };
    try {
      payload = this.jwt.verify<{ sub: number; jti: string; fid?: string }>(rawRefreshToken, {
        secret: this.config.TELECOM_HD_JWT_REFRESH_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Opportunistic cleanup of this staff's expired tokens (indexed, fire-and-forget) — DB
    // hygiene, preserved from main; failure must not block a valid refresh.
    void this.prisma.refreshToken
      .deleteMany({ where: { staffId: payload.sub, expiresAt: { lt: new Date() } } })
      .catch(() => undefined);

    // Direct single-row lookup by opaque jti — no candidate scan (S3-3).
    const row = await this.prisma.refreshToken.findUnique({ where: { jti: payload.jti } });
    if (!row) {
      throw new UnauthorizedException('Refresh token not found');
    }

    // Bind the presented raw token to the stored hash: a forged/guessed jti fails here.
    if (!(await verifyPassword(row.tokenHash, rawRefreshToken))) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (row.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token expired');
    }

    // Load the current staff BEFORE consuming, so a security change can't be outrun by
    // a concurrent rotation (S3 race fix). If the token's stamped authVersion no longer
    // matches the staff record, a logout-all / password / group change happened after
    // this token was issued → reject quietly (the family is already revoked by that
    // change; this is NOT a stolen-token replay, so no family-revoke alarm).
    const staff = await this.prisma.staff.findUnique({
      where: { id: row.staffId },
      include: { staffGroup: true },
    });
    if (!staff || !staff.isEnabled) {
      throw new UnauthorizedException('Staff not found or disabled');
    }
    if (row.authVersion !== staff.authVersion) {
      throw new UnauthorizedException('Session has been invalidated');
    }

    // Prepare the successor outside the transaction (JWT signing + Argon2 are CPU
    // work), then atomically consume the parent and persist the successor. A crash
    // can no longer burn the only refresh token without storing its replacement.
    const principal = this.buildPrincipal(staff);
    const tokens = await this.issueTokens(principal, staff.id, staff.authVersion, row.familyId);
    const successorHash = await hashPassword(tokens.refreshToken);
    const successorExpiresAt = new Date(Date.now() + this.config.TELECOM_HD_JWT_REFRESH_TTL * 1000);
    const consumed = await this.prisma.$transaction(async (tx) => {
      const result = await tx.refreshToken.updateMany({
        where: { jti: row.jti, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count === 1) {
        await tx.refreshToken.create({
          data: {
            staffId: staff.id,
            jti: tokens.refreshJti,
            familyId: row.familyId,
            tokenHash: successorHash,
            expiresAt: successorExpiresAt,
            authVersion: staff.authVersion,
          },
        });
      }
      return result;
    });

    if (consumed.count !== 1) {
      // The jti was already consumed. Distinguish a benign concurrent double-submit
      // (winner rotated microseconds ago) from a genuine later replay of a stolen,
      // already-rotated token — only the latter revokes the whole family.
      const revokedAtMs = row.revokedAt ? row.revokedAt.getTime() : Date.now();
      const withinGrace = Date.now() - revokedAtMs <= REFRESH_ROTATION_GRACE_MS;
      if (!withinGrace) {
        await this.prisma.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.error(
          `SECURITY: refresh-token replay detected for staff ${row.staffId} — family revoked`,
        );
        throw new UnauthorizedException('Refresh token reuse detected; all sessions have been revoked');
      }
      // Concurrent browser-tab loser: issue only a fresh access cookie. The winner
      // owns the persisted rotated refresh token; omitting Set-Cookie for refresh
      // ensures this later response cannot overwrite or delete the winner's cookie.
      return { accessToken: tokens.accessToken, refreshRotated: false };
    }

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      refreshRotated: true,
    };
  }

  /**
   * Revoke all refresh tokens for the given staff member (logout).
   * The staffId comes from the verified JWT principal passed in by the controller.
   */
  async logout(staffId: number, accessJti?: string, accessExp?: number): Promise<void> {
    // Logout is an authoritative logout-all (S3-4): bump authVersion so every
    // outstanding access token for this staff fails the guard's `av` check on its
    // next request, and revoke all refresh families — atomically. Correctness no
    // longer depends on the Redis jti blocklist.
    await this.revokeStaffSessions(staffId);
    // Keep the jti blocklist as defense-in-depth / telemetry (best-effort).
    if (accessJti && this.blocklist) {
      const ttl = accessExp
        ? accessExp - Math.floor(Date.now() / 1000)
        : this.config.TELECOM_HD_JWT_ACCESS_TTL;
      await this.blocklist.block(accessJti, ttl);
    }
    this.logger.log(`Staff ${staffId} logged out (all sessions revoked)`);
  }

  /**
   * Immediately invalidate EVERY session for a staff member (S3-2 / S3-4): increment
   * authVersion — so all outstanding access tokens fail the guard's `av` check on
   * their next request — and revoke all active refresh tokens, in one transaction.
   * Callers: logout, password reset, operator password/group/disable changes.
   */
  async revokeStaffSessions(staffId: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.staff.update({
        where: { id: staffId },
        data: { authVersion: { increment: 1 } },
      }),
      this.prisma.refreshToken.updateMany({
        where: { staffId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    // Also fire main's Redis access-token cutoff (defense-in-depth; the DB authVersion
    // check is the authoritative guarantee, this makes the already-issued access JWT
    // stop working immediately rather than lingering for its remaining TTL).
    await this.sessions?.revokeAllForStaff(staffId);
  }

  // ─────────────────────────── Password reset ────────────────────────────────

  /**
   * Start reset issuance after the HTTP response path has been detached. This
   * removes the account-existence/SMTP timing oracle while keeping all failures
   * fail-safe: a background failure is logged without a token or email address.
   */
  queuePasswordReset(email: string): void {
    void this.forgotPassword(email).catch((err: unknown) => {
      this.logger.error(
        `Password-reset background task failed (${err instanceof Error ? err.name : 'UnknownError'})`,
      );
    });
  }

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

    // Indexed opportunistic cleanup bounds consumed/expired-row accumulation.
    // Failure is non-fatal: issuance correctness does not depend on cleanup.
    void this.prisma.passwordReset
      .deleteMany({ where: { expiresAt: { lt: new Date() } } })
      .catch(() => undefined);

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    const issuedAt = new Date();
    const reset = await this.prisma.passwordReset.create({
      // Stamp the security state that authorized this link. Any later password,
      // role, email, disable or logout-all change increments authVersion and makes
      // this link unusable even if it raced with the revocation cleanup.
      // Start INACTIVE. The row becomes active (`usedAt = NULL`) only after SMTP
      // accepts the message and a locked transaction revalidates Staff security
      // state. A crash can therefore create an unusable link, never a live unmailed one.
      data: {
        staffId: staff.id,
        tokenHash,
        expiresAt,
        authVersion: staff.authVersion,
        usedAt: issuedAt,
      },
    });

    // Deliver the raw token in a URL FRAGMENT (#token=…) so it never lands in proxy
    // access logs or the Referer header when the reset page loads (S1-5).
    const resetUrl = `${this.config.TELECOM_HD_PUBLIC_URL}/reset-password#token=${rawToken}`;

    if (!this.mailService) {
      // No mailer wired. In the running app MailModule always provides one, so this
      // is a misconfiguration in production — fail closed by invalidating the token
      // and logging a diagnostic that NEVER contains the raw link.
      if (this.config.NODE_ENV === 'production') {
        this.logger.error('Password-reset mailer is not configured; no email sent');
      }
      return;
    }

    try {
      // Strict dispatch performs bounded inline SMTP and throws on failure. It is
      // already off the HTTP response path (queuePasswordReset), so latency cannot
      // reveal whether the account exists.
      await this.mailService.sendTemplateStrict(email, 'password_reset', 'en', {
        firstName: staff.firstName ?? '',
        resetUrl,
        expiresInHours: '1',
      });
      const activated = await this.activateDeliveredReset(reset.id, staff.id, staff.authVersion);
      if (!activated) {
        this.logger.warn(`Delivered password-reset link was superseded for staffId ${staff.id}`);
      }
    } catch {
      // The token is still inactive. Keep the response generic and never log the link.
      this.logger.error(`Password-reset dispatch failed for staffId ${staff.id}`);
    }
  }

  /**
   * Activate one SMTP-accepted reset while holding the Staff row lock. Issuance,
   * reset consumption and security-state changes are thereby serialized. A later
   * already-active request wins over a slower older SMTP delivery.
   */
  private async activateDeliveredReset(
    resetId: number,
    staffId: number,
    issuedAuthVersion: number,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: number; authVersion: number; isEnabled: boolean }>
      >`SELECT "id", "authVersion", "isEnabled" FROM "Staff" WHERE "id" = ${staffId} FOR UPDATE`;
      const current = rows[0];
      if (!current?.isEnabled || current.authVersion !== issuedAuthVersion) return false;

      const newerActive = await tx.passwordReset.findFirst({
        where: { staffId, id: { gt: resetId }, usedAt: null, expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (newerActive) return false;

      const now = new Date();
      await tx.passwordReset.updateMany({
        where: { staffId, usedAt: null },
        data: { usedAt: now },
      });
      const activated = await tx.passwordReset.updateMany({
        where: {
          id: resetId,
          staffId,
          authVersion: issuedAuthVersion,
          usedAt: { not: null },
          expiresAt: { gt: now },
        },
        data: { usedAt: null },
      });
      return activated.count === 1;
    });
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

    // Cheap indexed rejection BEFORE Argon2. The nonce has 256 bits of entropy,
    // so timing here reveals no guessable account state; it only prevents invalid
    // traffic from consuming the expensive password-hash budget.
    const candidate = await this.prisma.passwordReset.findUnique({ where: { tokenHash } });
    const precheckNow = new Date();
    if (!candidate || candidate.usedAt !== null || candidate.expiresAt <= precheckNow) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    // Hash the new password BEFORE the race so the atomic consume→apply window stays
    // tiny (argon2 is deliberately slow).
    const passwordHash = await hashPassword(newPassword);

    // Consume + compare authVersion + change password in ONE transaction. The
    // conditional staff update is the ordering point against an admin password
    // change/disable/logout: either reset wins first and the later admin change wins,
    // or the security change bumps authVersion first and this transaction rolls back.
    const staffId = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Match activation's lock order (Staff then PasswordReset) to avoid a
      // reset-vs-delivery deadlock and serialize security-state changes.
      const lockedStaff = await tx.$queryRaw<Array<{ id: number }>>`
        SELECT "id" FROM "Staff" WHERE "id" = ${candidate.staffId} FOR UPDATE
      `;
      if (!lockedStaff[0]) {
        throw new BadRequestException('Invalid or expired reset token');
      }
      const record = await tx.passwordReset.findUnique({ where: { tokenHash } });
      if (!record || record.usedAt !== null || record.expiresAt <= now) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      const consumed = await tx.passwordReset.updateMany({
        where: { id: record.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) {
        throw new BadRequestException('Invalid or expired reset token');
      }

      const changed = await tx.staff.updateMany({
        where: { id: record.staffId, isEnabled: true, authVersion: record.authVersion },
        data: { passwordHash, authVersion: { increment: 1 } },
      });
      if (changed.count !== 1) {
        // Throwing rolls the token consume back too; the generic response reveals no state.
        throw new BadRequestException('Invalid or expired reset token');
      }

      await tx.refreshToken.updateMany({
        where: { staffId: record.staffId, revokedAt: null },
        data: { revokedAt: now },
      });
      await tx.passwordReset.updateMany({
        where: { staffId: record.staffId, usedAt: null },
        data: { usedAt: now },
      });
      return record.staffId;
    });

    // Add main's central Redis access-token cutoff so an already-issued access JWT cannot
    // continue working for its remaining TTL (complements the DB authVersion check).
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

  /** Issue access + refresh JWT pair. Returns the refresh `jti` so it can be persisted. */
  private async issueTokens(
    principal: AuthStaff,
    staffId: number,
    authVersion: number,
    familyId: string,
  ): Promise<TokenPair & { refreshJti: string }> {
    const refreshJti = crypto.randomUUID();

    const accessToken = await this.jwt.signAsync(
      // Distinct jti on the access token so logout can revoke it via the blocklist.
      // `av` (authVersion) is checked against the DB every request so security changes /
      // logout-all invalidate this token immediately (S3-1); `issuedAtMs` supports main's
      // central Redis session-revocation cutoff. Both guard checks run.
      { ...principal, sub: staffId, av: authVersion, issuedAtMs: Date.now(), jti: crypto.randomUUID() },
      {
        secret: this.config.TELECOM_HD_JWT_ACCESS_SECRET,
        expiresIn: this.config.TELECOM_HD_JWT_ACCESS_TTL,
      },
    );

    const refreshToken = await this.jwt.signAsync(
      // `jti` is the opaque row id looked up on rotation; `fid` groups the family (S3-3).
      { sub: staffId, jti: refreshJti, fid: familyId },
      {
        secret: this.config.TELECOM_HD_JWT_REFRESH_SECRET,
        expiresIn: this.config.TELECOM_HD_JWT_REFRESH_TTL,
      },
    );

    return { accessToken, refreshToken, refreshJti };
  }

  /** Persist a hashed copy of the raw refresh token with its opaque jti + family id. */
  private async persistRefreshToken(
    staffId: number,
    rawToken: string,
    jti: string,
    familyId: string,
    authVersion: number,
  ): Promise<void> {
    const tokenHash = await hashPassword(rawToken);
    const expiresAt = new Date(Date.now() + this.config.TELECOM_HD_JWT_REFRESH_TTL * 1000);

    await this.prisma.refreshToken.create({
      data: { staffId, jti, familyId, tokenHash, expiresAt, authVersion },
    });
  }
}
