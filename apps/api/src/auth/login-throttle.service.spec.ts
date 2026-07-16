import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException } from '@nestjs/common';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    incr: vi.fn(),
    expire: vi.fn(),
    del: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('ioredis', () => ({ default: vi.fn(() => redisMock) }));

import { LoginThrottleService } from './login-throttle.service';
import type { AppConfig } from '../config/configuration';

const CONFIG = {
  REDIS_URL: 'redis://localhost:6379',
  TELECOM_HD_JWT_ACCESS_SECRET: 'x'.repeat(32),
} as AppConfig;

describe('LoginThrottleService (S3-7)', () => {
  let svc: LoginThrottleService;
  beforeEach(() => {
    vi.clearAllMocks();
    svc = new LoginThrottleService(CONFIG);
  });

  it('is a no-op without an ip (nothing to key on)', async () => {
    await svc.assertNotThrottled('a@b.c', undefined);
    await svc.recordFailure('a@b.c', undefined);
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.incr).not.toHaveBeenCalled();
  });

  it('allows attempts under the threshold', async () => {
    redisMock.get.mockResolvedValue('3');
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).resolves.toBeUndefined();
  });

  it('throws a generic 429 at/over the threshold', async () => {
    redisMock.get.mockResolvedValue('10');
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).rejects.toBeInstanceOf(HttpException);
  });

  it('fails OPEN when Redis errors (never blocks logins on an outage)', async () => {
    redisMock.get.mockRejectedValue(new Error('redis down'));
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).resolves.toBeUndefined();
  });

  it('records a failure (INCR + sliding TTL)', async () => {
    redisMock.incr.mockResolvedValue(1);
    await svc.recordFailure('a@b.c', '1.2.3.4');
    expect(redisMock.incr).toHaveBeenCalledTimes(1);
    expect(redisMock.expire).toHaveBeenCalledTimes(1);
  });

  it('keys by HMAC(email) + ip — the raw email is never stored', async () => {
    redisMock.get.mockResolvedValue(null);
    await svc.assertNotThrottled('secret@example.com', '203.0.113.9');
    const key = (redisMock.get.mock.calls[0]?.[0] ?? '') as string;
    expect(key).not.toContain('secret@example.com');
    expect(key).toContain('203.0.113.9');
    expect(key.startsWith('th:login:')).toBe(true);
  });

  it('clears the counter on success', async () => {
    await svc.clear('a@b.c', '1.2.3.4');
    expect(redisMock.del).toHaveBeenCalledTimes(1);
  });
});
