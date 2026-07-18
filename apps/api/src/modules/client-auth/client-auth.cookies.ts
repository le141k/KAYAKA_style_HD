import type { AppConfig } from '../../config/configuration';

export const DEV_CLIENT_SESSION_COOKIE = 'th_client';
export const LEGACY_PROD_CLIENT_SESSION_COOKIE = '__Secure-th_client';
export const PROD_CLIENT_SESSION_COOKIE = '__Host-th_client';
/** Backward-compatible development/test export. */
export const CLIENT_SESSION_COOKIE = DEV_CLIENT_SESSION_COOKIE;

export function clientSessionCookieName(config: Pick<AppConfig, 'NODE_ENV'>): string {
  return config.NODE_ENV === 'production' ? PROD_CLIENT_SESSION_COOKIE : DEV_CLIENT_SESSION_COOKIE;
}
