import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClientAuthService, type ClientPrincipal } from './client-auth.service';
import { clientSessionCookieName } from './client-auth.cookies';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';

/**
 * Enforces a verified client session (GOAL_PUBLIC_SECURITY S2-6). Reads the HttpOnly
 * `th_client` cookie, resolves it to a `{ userId }` principal, and attaches it to
 * `req.client`. Rejects missing / expired / revoked sessions with 401. Fails CLOSED
 * (503) on an auth-store outage. Never reuses staff JWT/RBAC identity.
 */
@Injectable()
export class ClientAuthGuard implements CanActivate {
  constructor(
    private readonly clientAuth: ClientAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { client?: ClientPrincipal }>();
    const raw = this.readCookie(request.headers['cookie'], clientSessionCookieName(this.config));
    if (!raw) {
      throw new UnauthorizedException('Client session required');
    }

    let principal: ClientPrincipal | null;
    try {
      principal = await this.clientAuth.resolveSession(raw);
    } catch {
      throw new ServiceUnavailableException('Auth state temporarily unavailable');
    }
    if (!principal) {
      throw new UnauthorizedException('Client session invalid or expired');
    }

    request.client = principal;
    return true;
  }

  private readCookie(header: string | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === name) {
        return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
      }
    }
    return undefined;
  }
}
