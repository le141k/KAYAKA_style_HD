import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../prisma/prisma.service';
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

/** A DB Staff row (with joined group) as the guard's findUnique would return it. */
function staffRow(over: Record<string, unknown> = {}) {
  return {
    id: 7,
    email: 'staff@x.com',
    firstName: 'S',
    lastName: 'T',
    isEnabled: true,
    authVersion: 0,
    staffGroup: { isAdmin: false, permissions: ['ticket.view'] },
    ...over,
  };
}

function makeGuard(opts: {
  isPublic?: boolean;
  verifyResult?: Record<string, unknown>;
  verifyThrows?: boolean;
  blocked?: boolean;
  staleSession?: boolean;
  staff?: unknown; // findUnique result; `undefined` key uses a default enabled staff
  prismaThrows?: boolean;
}) {
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => (key === IS_PUBLIC_KEY ? opts.isPublic : undefined)),
  } as unknown as Reflector;
  const jwt = {
    verifyAsync: vi.fn(async () => {
      if (opts.verifyThrows) throw new Error('bad');
      return opts.verifyResult ?? { sub: 7, av: 0, jti: 'j' };
    }),
  } as unknown as JwtService;
  const blocklist = {
    isBlocked: vi.fn(async () => opts.blocked ?? false),
    isStaffTokenStale: vi.fn(async () => opts.staleSession ?? false),
  };
  const findUnique = vi.fn(async () => {
    if (opts.prismaThrows) throw new Error('db down');
    return 'staff' in opts ? opts.staff : staffRow();
  });
  const prisma = { staff: { findUnique } } as unknown as PrismaService;
  return {
    guard: new JwtAuthGuard(jwt, reflector, CONFIG, prisma, blocklist as never),
    jwt,
    blocklist,
    findUnique,
  };
}

describe('JwtAuthGuard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows a @Public() route without any token (no DB hit)', async () => {
    const { guard, findUnique } = makeGuard({ isPublic: true });
    await expect(guard.canActivate(makeContext({ headers: {} }))).resolves.toBe(true);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects an undecorated (protected) route with no token → 401', async () => {
    const { guard } = makeGuard({ isPublic: false });
    await expect(guard.canActivate(makeContext({ headers: {} }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts a valid Bearer token and populates req.user from the DB record', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, av: 0, jti: 'j' },
      staff: staffRow({ id: 7 }),
    });
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer good-token' } };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect((req as { user: { staffId: number } }).user.staffId).toBe(7);
  });

  it('accepts a token from the HttpOnly cookie when no Bearer header is present', async () => {
    const { guard, jwt } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 9, av: 0, jti: 'j' },
      staff: staffRow({ id: 9 }),
    });
    const req: Record<string, unknown> = {
      headers: { cookie: `${ACCESS_TOKEN_COOKIE}=cookie-token; other=1` },
    };
    await expect(guard.canActivate(makeContext(req))).resolves.toBe(true);
    expect(jwt.verifyAsync).toHaveBeenCalledWith('cookie-token', expect.anything());
    expect((req as { user: { staffId: number } }).user.staffId).toBe(9);
  });

  it('rejects an invalid/expired token → 401 (no DB hit)', async () => {
    const { guard, findUnique } = makeGuard({ isPublic: false, verifyThrows: true });
    const req = { headers: { authorization: 'Bearer rotten' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects a revoked (blocklisted) jti → 401', async () => {
    const { guard, blocklist } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, av: 0, jti: 'revoked-jti' },
      blocked: true,
    });
    const req = { headers: { authorization: 'Bearer good-but-revoked' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(blocklist.isBlocked).toHaveBeenCalledWith('revoked-jti');
  });

  it('rejects an access token issued before the staff revocation cutoff → 401 (Redis)', async () => {
    const { guard, blocklist } = makeGuard({
      isPublic: false,
      verifyResult: {
        sub: 7,
        email: 's@x.com',
        isAdmin: false,
        permissions: [],
        issuedAtMs: 1_000_123,
        iat: 1000,
      },
      staleSession: true,
    });
    const req = { headers: { authorization: 'Bearer stale-after-role-change' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(blocklist.isStaffTokenStale).toHaveBeenCalledWith(7, 1_000_123, 1000);
  });

  it('rejects a token for a now-disabled staff member → 401', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, av: 0, jti: 'j' },
      staff: staffRow({ isEnabled: false }),
    });
    const req = { headers: { authorization: 'Bearer t' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token whose authVersion no longer matches the DB → 401 (S3-1)', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, av: 0, jti: 'j' },
      staff: staffRow({ authVersion: 1 }), // security change bumped it
    });
    const req = { headers: { authorization: 'Bearer stale' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a pre-S3 token that carries no av claim → 401', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, jti: 'j' }, // no `av`
      staff: staffRow({ authVersion: 0 }),
    });
    const req = { headers: { authorization: 'Bearer legacy' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails CLOSED with 503 when the auth store is unreachable (S3-8)', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, av: 0, jti: 'j' },
      prismaThrows: true,
    });
    const req = { headers: { authorization: 'Bearer t' } };
    await expect(guard.canActivate(makeContext(req))).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('derives permissions from the DB group, not the (stale) token claims', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      // Token claims admin + broad perms…
      verifyResult: { sub: 7, av: 0, jti: 'j', isAdmin: true, permissions: ['everything'] },
      // …but the live group has been de-privileged.
      staff: staffRow({ staffGroup: { isAdmin: false, permissions: ['ticket.view'] } }),
    });
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer t' } };
    await guard.canActivate(makeContext(req));
    const user = (req as { user: { isAdmin: boolean; permissions: string[] } }).user;
    expect(user.isAdmin).toBe(false);
    expect(user.permissions).toEqual(['ticket.view']);
  });

  it('carries jti + exp onto req.user for logout revocation', async () => {
    const { guard } = makeGuard({
      isPublic: false,
      verifyResult: { sub: 7, av: 0, jti: 'jti-1', exp: 999 },
      staff: staffRow(),
    });
    const req: Record<string, unknown> = { headers: { authorization: 'Bearer t' } };
    await guard.canActivate(makeContext(req));
    expect((req as { user: { jti?: string; exp?: number } }).user.jti).toBe('jti-1');
    expect((req as { user: { jti?: string; exp?: number } }).user.exp).toBe(999);
  });
});
