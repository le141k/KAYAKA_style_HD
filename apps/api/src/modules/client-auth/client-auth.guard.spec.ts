import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ClientAuthGuard } from './client-auth.guard';
import { CLIENT_SESSION_COOKIE, PROD_CLIENT_SESSION_COOKIE } from './client-auth.cookies';
import type { ClientAuthService } from './client-auth.service';
import type { AppConfig } from '../../config/configuration';

function ctxWithCookie(cookie?: string): ExecutionContext {
  const req: Record<string, unknown> = { headers: cookie ? { cookie } : {} };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeGuard(opts: { resolve?: unknown; throws?: boolean; production?: boolean }) {
  const clientAuth = {
    resolveSession: vi.fn(async () => {
      if (opts.throws) throw new Error('db down');
      return opts.resolve ?? null;
    }),
  } as unknown as ClientAuthService;
  return new ClientAuthGuard(clientAuth, {
    NODE_ENV: opts.production ? 'production' : 'test',
  } as AppConfig);
}

describe('ClientAuthGuard', () => {
  it('rejects a request with no session cookie → 401', async () => {
    const guard = makeGuard({});
    await expect(guard.canActivate(ctxWithCookie())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid/expired session (resolve → null) → 401', async () => {
    const guard = makeGuard({ resolve: null });
    await expect(
      guard.canActivate(ctxWithCookie(`${CLIENT_SESSION_COOKIE}=deadbeef`)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid session and attaches req.client', async () => {
    const guard = makeGuard({ resolve: { userId: 5 } });
    const ctx = ctxWithCookie(`${CLIENT_SESSION_COOKIE}=good; other=1`);
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest<{ client?: { userId: number } }>();
    expect(req.client).toEqual({ userId: 5 });
  });

  it('uses the domain-cookie-proof __Host cookie name in production', async () => {
    const guard = makeGuard({ resolve: { userId: 5 }, production: true });
    await expect(guard.canActivate(ctxWithCookie(`${PROD_CLIENT_SESSION_COOKIE}=good`))).resolves.toBe(true);
    await expect(guard.canActivate(ctxWithCookie(`${CLIENT_SESSION_COOKIE}=legacy`))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails CLOSED with 503 when the auth store is unreachable', async () => {
    const guard = makeGuard({ throws: true });
    await expect(guard.canActivate(ctxWithCookie(`${CLIENT_SESSION_COOKIE}=good`))).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
