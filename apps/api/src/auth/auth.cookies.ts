import type { Response } from 'express';
import type { AppConfig } from '../config/configuration';

export const DEV_ACCESS_TOKEN_COOKIE = 'th_access';
export const PROD_ACCESS_TOKEN_COOKIE = '__Host-th_access';
export const DEV_REFRESH_TOKEN_COOKIE = 'th_refresh';
export const LEGACY_PROD_REFRESH_TOKEN_COOKIE = '__Secure-th_refresh';
export const PROD_REFRESH_TOKEN_COOKIE = '__Host-th_refresh';
export const DEV_CSRF_COOKIE = 'th_csrf';
export const PROD_CSRF_COOKIE = '__Host-th_csrf';

export const ACCESS_COOKIE_PATH = '/';
export const REFRESH_COOKIE_PATH = '/';
export const LEGACY_REFRESH_COOKIE_PATH = '/api/auth/refresh';

export interface AuthCookieNames {
  access: string;
  refresh: string;
  csrf: string;
}

export function authCookieNames(config: Pick<AppConfig, 'NODE_ENV'>): AuthCookieNames {
  const production = config.NODE_ENV === 'production';
  return {
    access: production ? PROD_ACCESS_TOKEN_COOKIE : DEV_ACCESS_TOKEN_COOKIE,
    refresh: production ? PROD_REFRESH_TOKEN_COOKIE : DEV_REFRESH_TOKEN_COOKIE,
    csrf: production ? PROD_CSRF_COOKIE : DEV_CSRF_COOKIE,
  };
}

/** Parse one cookie without requiring cookie-parser. Malformed values are ignored. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Clear current and legacy browser-auth cookies, including their historical paths. */
export function clearBrowserAuthCookies(res: Response, config: Pick<AppConfig, 'NODE_ENV'>): void {
  const secure = config.NODE_ENV === 'production';
  const protectedBase = { httpOnly: true, secure, sameSite: 'lax' as const };
  const readableBase = { httpOnly: false, secure, sameSite: 'lax' as const };

  for (const name of [DEV_ACCESS_TOKEN_COOKIE, PROD_ACCESS_TOKEN_COOKIE]) {
    res.clearCookie(name, { ...protectedBase, path: ACCESS_COOKIE_PATH });
  }
  for (const name of [
    DEV_REFRESH_TOKEN_COOKIE,
    LEGACY_PROD_REFRESH_TOKEN_COOKIE,
    PROD_REFRESH_TOKEN_COOKIE,
  ]) {
    // Clear both historical and current paths/names during the __Host cutover.
    res.clearCookie(name, { ...protectedBase, path: ACCESS_COOKIE_PATH });
    res.clearCookie(name, { ...protectedBase, path: LEGACY_REFRESH_COOKIE_PATH });
  }
  for (const name of [DEV_CSRF_COOKIE, PROD_CSRF_COOKIE]) {
    res.clearCookie(name, { ...readableBase, path: ACCESS_COOKIE_PATH });
  }
  // Legacy JS-readable markers/tokens from pre-cookie-only builds.
  for (const name of ['auth_token', 'refresh_token', 'th_authed']) {
    res.clearCookie(name, { ...readableBase, path: ACCESS_COOKIE_PATH });
  }
}
