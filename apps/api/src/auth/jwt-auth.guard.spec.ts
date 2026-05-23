import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard, ACCESS_TOKEN_COOKIE } from './jwt-auth.guard';
import { IS_PUBLIC_KEY } from './auth.decorators';
import type { AppConfig } from '../config/configuration';

const CONFIG = { TELECOM_HD_JWT_ACCESS_SECRET: 'x'.repeat(32) } as AppConfig;

function makeContext(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeGuard(opts: {
  isPublic?: boolean;
  verifyResult?: unknown;
  verifyThrows?: boolean;
  blocked?: boolean;
}) {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === IS_PUBLIC_KEY ? opts.isPublic : undefined)),
  } as unknown as Reflector;
  const jwt = {
    verifyAsync: vi.fn(async () => {
      if (opts.verifyThrows) throw new Error('bad');
      return opts.verifyResult ?? { sub: 1, email: 'a@b.c', isAdmin: false, permissions: [] };
    }),
  } as unknown as JwtService;
  const blocklist = { isBlocked: vi.fn(async () => opts.blocked ?? false) };
  return {
    guard: new JwtAuthGuard(jwt, reflector, CONFIG, blocklist as never),
    jwt,
    blocklist,
  };
}

describe('JwtAuthGuard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows a @Public() route without any token', async () => {
    const { guard } = makeGuard({ isPublic: true });
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('rejects an undecorated (protected) route with no token → 401', async () => {
    const { guard } = makeGuard({ isPublic: false });
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid Bearer token and populates req.user', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, email: 'staff@x.com', isAdmin: true, permissions: ['ticket.view'] },
    });
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer good-token' } };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect((req as { user: { staffId: number } }).user.staffId).toBe(7);
  });

  it('accepts a token from the HttpOnly cookie when no Bearer header is present', async () => {
    const { guard, jwt } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 9, email: 'c@x.com', isAdmin: false, permissions: [] },
    });
    const req: Record<string, unknown> = {
      headers: { cookie: `${ACCESS_TOKEN_COOKIE}=cookie-token; other=1` },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(jwt.verifyAsync).toHaveBeenCalledWith('cookie-token', expect.anything());
    expect((req as { user: { staffId: number } }).user.staffId).toBe(9);
  });

  it('rejects an invalid/expired token → 401', async () => {
    const { guard } = makeGuard({ isPublic: false, verifyThrows: true });
    const req = { headers: { authorization: 'Bearer rotten' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a revoked (blocklisted) jti → 401', async () => {
    const { guard, blocklist } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, email: 's@x.com', isAdmin: false, permissions: [], jti: 'revoked-jti' },
      blocked: true,
    });
    const req = { headers: { authorization: 'Bearer good-but-revoked' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(blocklist.isBlocked).toHaveBeenCalledWith('revoked-jti');
  });

  it('carries jti + exp onto req.user for logout revocation', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, email: 's@x.com', isAdmin: false, permissions: [], jti: 'jti-1', exp: 999 },
    });
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer t' } };
    await guard.canActivate(makeContext(req));
    expect((req as { user: { jti?: string; exp?: number } }).user.jti).toBe('jti-1');
    expect((req as { user: { jti?: string; exp?: number } }).user.exp).toBe(999);
  });
});
