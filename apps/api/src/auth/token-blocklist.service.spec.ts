import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from '../config/configuration';

// Mock ioredis with a shared fake instance we can assert on.
const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    set: vi.fn().mockResolvedValue('OK'),
    exists: vi.fn().mockResolvedValue(0),
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
});
