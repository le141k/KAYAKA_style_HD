import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, AuthStaff } from './auth.decorators';
import type { Permission } from './permissions';
import { AppConfig, APP_CONFIG } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBlocklistService } from './token-blocklist.service';
import type { Request } from 'express';

/** Name of the HttpOnly access-token cookie set by AuthController on login/refresh. */
export const ACCESS_TOKEN_COOKIE = 'th_access';

/**
 * Global JWT guard.
 * - Routes decorated with @Public() bypass token validation entirely.
 * - All other routes require a valid access token, taken from EITHER the
 *   `Authorization: Bearer <token>` header OR the `th_access` HttpOnly cookie.
 *   The Bearer header takes precedence so legacy localStorage clients keep working
 *   during/after the cookie migration (dual-mode, fully backward compatible).
 * - On success, sets req.user to an AuthStaff principal.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    // Optional so unit tests can construct the guard without Redis; in the app
    // DI always provides it (AuthModule is @Global).
    @Optional() private readonly blocklist?: TokenBlocklistService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearer(request) ?? this.extractCookie(request);

    if (!token) {
      throw new UnauthorizedException('Missing access token');
    }

    let payload: AuthStaff & { sub: number; jti?: string; exp?: number; av?: number };
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.config.TELECOM_HD_JWT_ACCESS_SECRET,
      });
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    // Reject tokens revoked on logout (jti blocklist). Fail-open if Redis is down.
    if (payload.jti && this.blocklist && (await this.blocklist.isBlocked(payload.jti))) {
      throw new UnauthorizedException('Token has been revoked');
    }

    // Server-side source-of-truth check (S3-1): the token is only a claim. Verify the
    // CURRENT Staff record, its authVersion and its group's live permissions, so a
    // disable / password change / group or permission change and logout-all all take
    // effect on the very next request. Fail CLOSED (503) if the auth store is
    // unreachable — never fall through to the stale token claims (S3-8).
    const staffId = payload.staffId ?? payload.sub;
    let staff;
    try {
      staff = await this.prisma.staff.findUnique({
        where: { id: staffId },
        include: { staffGroup: true },
      });
    } catch {
      throw new ServiceUnavailableException('Auth state temporarily unavailable');
    }

    if (!staff || !staff.isEnabled) {
      throw new UnauthorizedException('Staff not found or disabled');
    }
    // authVersion mismatch ⇒ this token predates a security change (or is a pre-S3
    // token with no `av`) ⇒ reject. Revocation is therefore immediate.
    if (staff.authVersion !== payload.av) {
      throw new UnauthorizedException('Session has been invalidated');
    }

    const firstName = staff.firstName ?? '';
    const lastName = staff.lastName ?? '';
    const principal: AuthStaff = {
      staffId: staff.id,
      email: staff.email,
      isAdmin: staff.staffGroup.isAdmin,
      permissions: staff.staffGroup.permissions as Permission[],
      firstName,
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || staff.email,
      // Carry jti + exp so logout can revoke this exact token.
      jti: payload.jti,
      exp: payload.exp,
    };
    (request as Request & { user: AuthStaff }).user = principal;

    return true;
  }

  private extractBearer(request: Request): string | undefined {
    const auth = request.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return undefined;
    return auth.slice(7);
  }

  /**
   * Read the access token from the HttpOnly `th_access` cookie. Parses the raw
   * Cookie header directly so this works even without cookie-parser middleware.
   */
  private extractCookie(request: Request): string | undefined {
    // Prefer a pre-parsed cookies bag if some middleware populated it.
    const parsed = (request as Request & { cookies?: Record<string, string> }).cookies;
    if (parsed && typeof parsed[ACCESS_TOKEN_COOKIE] === 'string') {
      return parsed[ACCESS_TOKEN_COOKIE] || undefined;
    }
    const header = request.headers['cookie'];
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      if (name === ACCESS_TOKEN_COOKIE) {
        return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
      }
    }
    return undefined;
  }
}
