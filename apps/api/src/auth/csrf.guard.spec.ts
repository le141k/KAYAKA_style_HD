import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';
import { CsrfService } from './csrf.service';
import type { AppConfig } from '../config/configuration';

const ORIGIN = 'https://help.example.net';
const CONFIG = {
  NODE_ENV: 'test',
  TELECOM_HD_PUBLIC_URL: ORIGIN,
  TELECOM_HD_JWT_ACCESS_SECRET: 'csrf-test-access-secret-at-least-32-chars',
  TELECOM_HD_JWT_REFRESH_TTL: 3600,
} as AppConfig;
const csrf = new CsrfService(CONFIG);
const guard = new CsrfGuard(CONFIG, csrf);

function ctx(req: {
  method: string;
  url?: string;
  headers?: Record<string, string | undefined>;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        method: req.method,
        originalUrl: req.url ?? '/api/tickets/1',
        headers: req.headers ?? {},
      }),
    }),
  } as unknown as ExecutionContext;
}

function validCookie(auth = 'th_access=access'): { cookie: string; token: string } {
  const token = csrf.createToken();
  return { cookie: `${auth}; th_csrf=${token}`, token };
}

describe('CsrfGuard (signed double-submit + exact origin)', () => {
  it('allows safe methods regardless of origin', () => {
    expect(guard.canActivate(ctx({ method: 'GET', headers: { origin: 'https://evil.test' } }))).toBe(true);
  });

  it('allows Bearer-authenticated requests for external clients', () => {
    expect(
      guard.canActivate(
        ctx({ method: 'POST', headers: { authorization: 'Bearer x', origin: 'https://evil.test' } }),
      ),
    ).toBe(true);
  });

  it('allows cookieless shared-secret webhooks', () => {
    expect(
      guard.canActivate(
        ctx({ method: 'POST', headers: { 'x-alaris-secret': 's', origin: 'https://evil.test' } }),
      ),
    ).toBe(true);
  });

  it('rejects cookieless cross-origin login (login-CSRF)', () => {
    expect(() =>
      guard.canActivate(
        ctx({ method: 'POST', url: '/api/auth/login', headers: { origin: 'https://evil.test' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects case/trailing-slash variants that Express routes to login', () => {
    expect(() =>
      guard.canActivate(
        ctx({ method: 'POST', url: '/api/AUTH/LOGIN/', headers: { origin: 'https://evil.test' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('allows cookieless same-origin login', () => {
    expect(
      guard.canActivate(ctx({ method: 'POST', url: '/api/auth/login', headers: { origin: ORIGIN } })),
    ).toBe(true);
  });

  it('allows same-origin mutation with matching signed cookie/header', () => {
    const { cookie, token } = validCookie('th_client=client-session');
    expect(
      guard.canActivate(ctx({ method: 'POST', headers: { cookie, origin: ORIGIN, 'x-csrf-token': token } })),
    ).toBe(true);
  });

  it('validates only the hardened CSRF cookie name in production', () => {
    const productionConfig = { ...CONFIG, NODE_ENV: 'production' } as AppConfig;
    const productionCsrf = new CsrfService(productionConfig);
    const productionGuard = new CsrfGuard(productionConfig, productionCsrf);
    const token = productionCsrf.createToken();

    expect(
      productionGuard.canActivate(
        ctx({
          method: 'POST',
          headers: {
            cookie: `__Host-th_access=access; __Host-th_csrf=${token}`,
            origin: ORIGIN,
            'x-csrf-token': token,
          },
        }),
      ),
    ).toBe(true);
  });

  it('protects the hardened production client-session cookie', () => {
    const productionConfig = { ...CONFIG, NODE_ENV: 'production' } as AppConfig;
    const productionCsrf = new CsrfService(productionConfig);
    const productionGuard = new CsrfGuard(productionConfig, productionCsrf);
    const token = productionCsrf.createToken();

    expect(
      productionGuard.canActivate(
        ctx({
          method: 'POST',
          headers: {
            cookie: `__Host-th_client=session; __Host-th_csrf=${token}`,
            origin: ORIGIN,
            'x-csrf-token': token,
          },
        }),
      ),
    ).toBe(true);
  });

  it('rejects a same-origin cookie mutation without the double-submit header', () => {
    const { cookie } = validCookie();
    expect(() => guard.canActivate(ctx({ method: 'DELETE', headers: { cookie, origin: ORIGIN } }))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an unsigned/mismatched token', () => {
    const { cookie } = validCookie();
    expect(() =>
      guard.canActivate(ctx({ method: 'POST', headers: { cookie, origin: ORIGIN, 'x-csrf-token': 'bad' } })),
    ).toThrow(ForbiddenException);
  });

  it('rejects cross-origin refresh carrying only the production refresh cookie', () => {
    const { cookie, token } = validCookie('__Host-th_refresh=refresh');
    expect(() =>
      guard.canActivate(
        ctx({
          method: 'POST',
          url: '/api/auth/refresh',
          headers: { cookie, origin: 'https://evil.test', 'x-csrf-token': token },
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('rejects a subdomain origin (no wildcard match)', () => {
    const { cookie, token } = validCookie();
    expect(() =>
      guard.canActivate(
        ctx({
          method: 'POST',
          headers: { cookie, origin: 'https://evil.help.example.net', 'x-csrf-token': token },
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
