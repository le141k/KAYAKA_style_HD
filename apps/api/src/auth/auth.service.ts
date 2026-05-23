import { Injectable, UnauthorizedException, Logger, Inject, Optional } from '@nestjs/common';
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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly blocklist?: TokenBlocklistService,
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

    // Find and validate the stored token by jti (uuid in the token)
    const stored = await this.prisma.refreshToken.findMany({
      where: { staffId: payload.sub, revokedAt: null },
    });

    // Find matching token by verifying argon2 hash
    let matchedToken: (typeof stored)[number] | undefined;
    for (const t of stored) {
      if (new Date() > t.expiresAt) continue;
      const matches = await verifyPassword(t.tokenHash, rawRefreshToken);
      if (matches) {
        matchedToken = t;
        break;
      }
    }

    if (!matchedToken) {
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
