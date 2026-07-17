import { describe, it, expect } from 'vitest';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';
import type { AppConfig } from '../config/configuration';

const ORIGIN = 'https://help.example.net';
const guard = new CsrfGuard({ TELECOM_HD_PUBLIC_URL: ORIGIN } as AppConfig);

function ctx(req: { method: string; headers?: Record<string, string | undefined> }): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ method: req.method, headers: req.headers ?? {} }) }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard (S3-5 origin validation)', () => {
  it('allows safe methods regardless of origin', () => {
    expect(guard.canActivate(ctx({ method: 'GET', headers: { origin: 'https://evil.test' } }))).toBe(true);
  });

  it('allows Bearer-authenticated requests (header auth is CSRF-immune)', () => {
    expect(
      guard.canActivate(
        ctx({ method: 'POST', headers: { authorization: 'Bearer x', origin: 'https://evil.test' } }),
      ),
    ).toBe(true);
  });

  it('allows cookieless requests (no ambient credential — covers webhooks)', () => {
    expect(
      guard.canActivate(
        ctx({ method: 'POST', headers: { 'x-alaris-secret': 's', origin: 'https://evil.test' } }),
      ),
    ).toBe(true);
  });

  it('allows a cookie-authenticated mutation from the SAME origin', () => {
    expect(
      guard.canActivate(ctx({ method: 'POST', headers: { cookie: 'th_client=abc', origin: ORIGIN } })),
    ).toBe(true);
  });

  it('allows same-origin via Referer when Origin is absent', () => {
    expect(
      guard.canActivate(
        ctx({ method: 'POST', headers: { cookie: 'th_access=abc', referer: `${ORIGIN}/staff/tickets` } }),
      ),
    ).toBe(true);
  });

  it('REJECTS a cookie-authenticated mutation from a cross origin (403)', () => {
    expect(() =>
      guard.canActivate(
        ctx({ method: 'POST', headers: { cookie: 'th_client=abc', origin: 'https://evil.test' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('REJECTS a cookie-authenticated mutation with no Origin and no Referer', () => {
    expect(() => guard.canActivate(ctx({ method: 'DELETE', headers: { cookie: 'th_access=abc' } }))).toThrow(
      ForbiddenException,
    );
  });

  it('REJECTS a cross-origin refresh carrying ONLY th_refresh (th_access expired)', () => {
    expect(() =>
      guard.canActivate(
        ctx({ method: 'POST', headers: { cookie: 'th_refresh=abc', origin: 'https://evil.test' } }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('REJECTS a subdomain origin (no wildcard match)', () => {
    expect(() =>
      guard.canActivate(
        ctx({
          method: 'POST',
          headers: { cookie: 'th_client=abc', origin: 'https://evil.help.example.net' },
        }),
      ),
    ).toThrow(ForbiddenException);
  });
});
