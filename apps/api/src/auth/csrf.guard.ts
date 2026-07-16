import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig, APP_CONFIG } from '../config/configuration';

/** Methods that cannot change state and never need CSRF protection. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for COOKIE-authenticated unsafe requests (GOAL_PUBLIC_SECURITY S3-5).
 *
 * Ambient cookie credentials (`th_access` staff cookie, `th_client` client cookie) are
 * the only CSRF-exposed auth: a cross-site page can make the browser attach them. This
 * guard requires such requests to originate from the application's own origin.
 *
 *  - Safe methods (GET/HEAD/OPTIONS) always pass.
 *  - `Authorization: Bearer …` requests pass — a cross-site attacker cannot set that
 *    header, so header-auth is CSRF-immune.
 *  - Requests carrying NO auth cookie pass — there is no ambient credential to abuse
 *    (this also auto-exempts the shared-secret webhooks, which use headers, not cookies).
 *    The refresh cookie (`th_refresh`) counts too, so cookie-only `POST /auth/refresh`
 *    (when `th_access` has expired but `th_refresh` is still valid) is still origin-checked.
 *  - Otherwise the request's `Origin` (or, if absent, `Referer`) must EXACTLY equal the
 *    configured app origin — strict allowlist, no wildcard subdomains. Mismatch → 403.
 *
 * This is the Origin-validation half of S3-5; the signed double-submit token layer and
 * `__Host-` cookie hardening (S3-6) land with the cookie-only/same-origin foundation
 * (S1-6/7). `SameSite=Lax` on the auth cookies remains an independent second barrier.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.allowedOrigin = new URL(config.TELECOM_HD_PUBLIC_URL).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    // Bearer-authenticated requests are CSRF-immune (the header can't be set cross-site).
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return true;

    // No ambient cookie credential ⇒ nothing for CSRF to abuse (covers webhooks too).
    const cookieHeader = req.headers['cookie'];
    if (!cookieHeader || !/(?:^|;\s*)(?:th_access|th_client|th_refresh)=/.test(cookieHeader)) {
      return true;
    }

    // Cookie-authenticated mutation: require an exact same-origin Origin/Referer.
    if (this.originMatches(req.headers['origin']) || this.originMatches(req.headers['referer'])) {
      return true;
    }
    throw new ForbiddenException('CSRF validation failed: cross-origin request rejected');
  }

  private originMatches(header: string | string[] | undefined): boolean {
    if (typeof header !== 'string' || header.length === 0) return false;
    try {
      return new URL(header).origin === this.allowedOrigin;
    } catch {
      return false;
    }
  }
}
