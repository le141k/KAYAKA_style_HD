import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, AuthStaff } from './auth.decorators';
import { AppConfig, APP_CONFIG } from '../config/configuration';
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

    try {
      const payload = await this.jwtService.verifyAsync<AuthStaff & { sub: number }>(token, {
        secret: this.config.TELECOM_HD_JWT_ACCESS_SECRET,
      });

      // Normalise: staffId is stored in `sub` by AuthService
      const staff: AuthStaff = {
        staffId: payload.staffId ?? payload.sub,
        email: payload.email,
        isAdmin: payload.isAdmin,
        permissions: payload.permissions,
        // Carry the display-name claims through so /auth/me exposes them.
        firstName: payload.firstName,
        lastName: payload.lastName,
        fullName: payload.fullName,
      };
      (request as Request & { user: AuthStaff }).user = staff;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

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
