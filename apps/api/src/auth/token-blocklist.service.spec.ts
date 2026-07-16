import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../config/configuration';

// Mock ioredis with a shared fake instance we can assert on.
const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    exists: vi.fn().mockResolvedValue(0),
    get: vi.fn().mockResolvedValue(null),
    disconnect: vi.fn(),
  },
}));
vi.mock('ioredis', () => ({ default: vi.fn(() => redisMock) }));

import { TokenBlocklistService } from './token-blocklist.service';

const CONFIG = { REDIS_URL: 'redis://localhost:6379' } as AppConfig;

describe('TokenBlocklistService', () => {
  let svc: TokenBlocklistService;
  beforeEach(() => {
    vi.clearAllMocks();
    redisMock.exists.mockResolvedValue(0);
    redisMock.set.mockResolvedValue('OK');
    redisMock.get.mockResolvedValue(null);
    svc = new TokenBlocklistService(CONFIG);
  });

  it('block() stores the jti with an EX ttl', async () => {
    await svc.block('jti-1', 900);
    expect(redisMock.set).toHaveBeenCalledWith('th:revoked:jti-1', '1', 'EX', 900);
  });

  it('block() is a no-op for empty jti or non-positive ttl', async () => {
    await svc.block('', 900);
    await svc.block('jti-2', 0);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('isBlocked() true when the key exists, false otherwise', async () => {
    redisMock.exists.mockResolvedValueOnce(1);
    expect(await svc.isBlocked('jti-1')).toBe(true);
    redisMock.exists.mockResolvedValueOnce(0);
    expect(await svc.isBlocked('jti-1')).toBe(false);
  });

  it('isBlocked(undefined) → false without hitting Redis', async () => {
    expect(await svc.isBlocked(undefined)).toBe(false);
    expect(redisMock.exists).not.toHaveBeenCalled();
  });

  it('fail-open: Redis error on isBlocked → false (never lock everyone out)', async () => {
    redisMock.exists.mockRejectedValueOnce(new Error('redis down'));
    expect(await svc.isBlocked('jti-1')).toBe(false);
  });

  // ─── per-staff access cutoff (role/password/disable revocation) ──────────────

  it('revokeStaffAccessBefore() stores a millisecond cutoff with an EX ttl', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_123);
    await svc.revokeStaffAccessBefore(42, 900);
    expect(redisMock.set).toHaveBeenCalledWith('th:staffcutoff:42', '1700000000123', 'EX', 900);
  });

  it('revokeStaffAccessBefore() is a no-op for missing staffId or non-positive ttl', async () => {
    await svc.revokeStaffAccessBefore(0, 900);
    await svc.revokeStaffAccessBefore(42, 0);
    expect(redisMock.set).not.toHaveBeenCalled();
  });

  it('isStaffTokenStale() rejects an access token issued at or before the millisecond cutoff', async () => {
    redisMock.get.mockResolvedValueOnce('1700000000500');
    expect(await svc.isStaffTokenStale(42, 1_700_000_000_499)).toBe(true);
    redisMock.get.mockResolvedValueOnce('1700000000500');
    expect(await svc.isStaffTokenStale(42, 1_700_000_000_500)).toBe(true);
  });

  it('isStaffTokenStale() accepts a token minted later in the same second', async () => {
    redisMock.get.mockResolvedValueOnce('1700000000500');
    expect(await svc.isStaffTokenStale(42, 1_700_000_000_501)).toBe(false);
  });

  it('isStaffTokenStale() falls back to iat for a legacy access token and old seconds cutoff', async () => {
    redisMock.get.mockResolvedValueOnce('1000');
    expect(await svc.isStaffTokenStale(42, undefined, 1000)).toBe(true);
    redisMock.get.mockResolvedValueOnce('1000');
    expect(await svc.isStaffTokenStale(42, undefined, 1001)).toBe(false);
  });

  it('isStaffTokenStale() false when no cutoff is set', async () => {
    redisMock.get.mockResolvedValueOnce(null);
    expect(await svc.isStaffTokenStale(42, 999_000)).toBe(false);
  });

  it('isStaffTokenStale() false (no Redis hit) when staffId and issue time are missing', async () => {
    expect(await svc.isStaffTokenStale(undefined, 999_000)).toBe(false);
    expect(await svc.isStaffTokenStale(42, undefined, undefined)).toBe(false);
    expect(redisMock.get).not.toHaveBeenCalled();
  });

  it('fail-open: Redis error on isStaffTokenStale → false', async () => {
    redisMock.get.mockRejectedValueOnce(new Error('redis down'));
    expect(await svc.isStaffTokenStale(42, 999_000)).toBe(false);
  });
});
