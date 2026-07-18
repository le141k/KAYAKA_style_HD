import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AppConfig, APP_CONFIG } from '../config/configuration';
import {
  DEV_ACCESS_TOKEN_COOKIE,
  DEV_REFRESH_TOKEN_COOKIE,
  LEGACY_PROD_REFRESH_TOKEN_COOKIE,
  PROD_ACCESS_TOKEN_COOKIE,
  PROD_REFRESH_TOKEN_COOKIE,
  readCookie,
} from './auth.cookies';
import { CsrfService } from './csrf.service';
import {
  DEV_CLIENT_SESSION_COOKIE,
  LEGACY_PROD_CLIENT_SESSION_COOKIE,
  PROD_CLIENT_SESSION_COOKIE,
} from '../modules/client-auth/client-auth.cookies';

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
 * Cookie-authenticated mutations additionally require a signed double-submit token in
 * both the readable CSRF cookie and `X-CSRF-Token`. Login/refresh/client-verify require
 * exact-origin validation even before a credential cookie exists, preventing login CSRF.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly allowedOrigin: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    private readonly csrf: CsrfService,
  ) {
    this.allowedOrigin = new URL(config.TELECOM_HD_PUBLIC_URL).origin;
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    // Bearer-authenticated requests are CSRF-immune (the header can't be set cross-site).
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return true;

    // No ambient cookie credential normally means nothing for CSRF to abuse (covers
    // shared-secret webhooks). Cookie-establishing auth endpoints are the exception:
    // they still require exact origin so an attacker cannot log a victim into the
    // attacker's staff/client account with a cross-site form submission.
    const cookieHeader = req.headers['cookie'];
    if (!this.hasAuthCookie(cookieHeader)) {
      if (this.establishesBrowserSession(req)) {
        if (this.requestOriginMatches(req)) return true;
        throw new ForbiddenException('CSRF validation failed: cross-origin request rejected');
      }
      return true;
    }

    // Cookie-authenticated mutation: require exact origin AND signed double-submit.
    if (!this.requestOriginMatches(req)) {
      throw new ForbiddenException('CSRF validation failed: cross-origin request rejected');
    }
    if (!this.csrf.isValid(this.csrf.cookieFromHeader(cookieHeader), req.headers['x-csrf-token'])) {
      // Give the same-origin browser client a machine-readable reason so it can
      // safely mint a fresh token and retry.  The guard rejects the request
      // before the controller runs, so this specific retry cannot duplicate a
      // completed mutation.
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        message: 'CSRF validation failed: token missing or invalid',
        code: 'CSRF_TOKEN_INVALID',
      });
    }
    return true;
  }

  private hasAuthCookie(header: string | undefined): boolean {
    return [
      DEV_ACCESS_TOKEN_COOKIE,
      PROD_ACCESS_TOKEN_COOKIE,
      DEV_REFRESH_TOKEN_COOKIE,
      LEGACY_PROD_REFRESH_TOKEN_COOKIE,
      PROD_REFRESH_TOKEN_COOKIE,
      DEV_CLIENT_SESSION_COOKIE,
      LEGACY_PROD_CLIENT_SESSION_COOKIE,
      PROD_CLIENT_SESSION_COOKIE,
    ].some((name) => readCookie(header, name) !== undefined);
  }

  private establishesBrowserSession(req: Request): boolean {
    // Express routing is case-insensitive and non-strict by default, so the CSRF
    // classification must normalize the same variants (`/LOGIN/` included).
    const rawPath = (req.originalUrl || req.url || '').split('?')[0] ?? '';
    const path = (rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath).toLowerCase();
    return [
      '/api/auth/login',
      '/auth/login',
      '/api/auth/refresh',
      '/auth/refresh',
      '/api/client-auth/verify',
      '/client-auth/verify',
    ].includes(path);
  }

  private requestOriginMatches(req: Request): boolean {
    // Prefer Origin when present; only fall back to Referer when Origin is absent.
    const origin = req.headers['origin'];
    return origin !== undefined ? this.originMatches(origin) : this.originMatches(req.headers['referer']);
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
