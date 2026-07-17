import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    get: vi.fn(),
    eval: vi.fn(),
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

const WINDOW_SECONDS = 15 * 60;

describe('LoginThrottleService (S3-7)', () => {
  let svc: LoginThrottleService;
  beforeEach(() => {
    // Reset only the per-call command mocks (clearing their leaked implementations) and
    // give them safe defaults; leave the constructor mocks (connect/quit + the ioredis
    // factory) with their hoisted implementations so `new Redis().connect().catch(…)` works.
    redisMock.get.mockReset().mockResolvedValue(null);
    redisMock.eval.mockReset().mockResolvedValue(1);
    redisMock.del.mockReset().mockResolvedValue(1);
    redisMock.connect.mockClear();
    redisMock.quit.mockClear();
    svc = new LoginThrottleService(CONFIG);
  });

  it('is a no-op without an ip (nothing to key on)', async () => {
    await svc.assertNotThrottled('a@b.c', undefined);
    await svc.recordFailure('a@b.c', undefined);
    await svc.clear('a@b.c', undefined);
    expect(redisMock.get).not.toHaveBeenCalled();
    expect(redisMock.eval).not.toHaveBeenCalled();
    expect(redisMock.del).not.toHaveBeenCalled();
  });

  it('allows attempts under the threshold', async () => {
    redisMock.get.mockResolvedValue('3');
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).resolves.toBeUndefined();
  });

  it('allows the last attempt BELOW the threshold (9) and blocks AT the threshold (10)', async () => {
    redisMock.get.mockResolvedValue('9');
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).resolves.toBeUndefined();
    redisMock.get.mockResolvedValue('10');
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).rejects.toBeInstanceOf(HttpException);
  });

  it('throws a generic 429 (status + non-revealing message) at/over the threshold', async () => {
    redisMock.get.mockResolvedValue('10');
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
    });
    // Message discloses nothing about the account or a "lock".
    try {
      await svc.assertNotThrottled('a@b.c', '1.2.3.4');
    } catch (e) {
      const msg = (e as HttpException).message.toLowerCase();
      expect(msg).not.toContain('lock');
      expect(msg).not.toContain('account');
    }
  });

  it('fails OPEN when the read errors (never blocks logins on an outage)', async () => {
    redisMock.get.mockRejectedValue(new Error('redis down'));
    await expect(svc.assertNotThrottled('a@b.c', '1.2.3.4')).resolves.toBeUndefined();
  });

  it('fails OPEN when recordFailure / clear error (best-effort, never throws)', async () => {
    redisMock.eval.mockRejectedValue(new Error('redis down'));
    redisMock.del.mockRejectedValue(new Error('redis down'));
    await expect(svc.recordFailure('a@b.c', '1.2.3.4')).resolves.toBeUndefined();
    await expect(svc.clear('a@b.c', '1.2.3.4')).resolves.toBeUndefined();
  });

  it('records a failure atomically (single eval INCR+EXPIRE with the window TTL)', async () => {
    redisMock.eval.mockResolvedValue(1);
    await svc.recordFailure('a@b.c', '1.2.3.4');
    // One round-trip, not a separate INCR then EXPIRE.
    expect(redisMock.eval).toHaveBeenCalledTimes(1);
    const [, numKeys, key, ttl] = redisMock.eval.mock.calls[0] as unknown[];
    expect(numKeys).toBe(1);
    expect(key).toContain('1.2.3.4');
    expect(ttl).toBe(String(WINDOW_SECONDS));
  });

  it('keys by HMAC(email) + ip — the raw email is never stored', async () => {
    redisMock.get.mockResolvedValue(null);
    await svc.assertNotThrottled('secret@example.com', '203.0.113.9');
    const key = (redisMock.get.mock.calls[0]?.[0] ?? '') as string;
    expect(key).not.toContain('secret@example.com');
    expect(key).toContain('203.0.113.9');
    expect(key.startsWith('th:login:')).toBe(true);
  });

  it('never locks an account: the SAME email from two IPs yields two independent keys', async () => {
    redisMock.get.mockResolvedValue(null);
    await svc.assertNotThrottled('victim@example.com', '198.51.100.1');
    await svc.assertNotThrottled('victim@example.com', '198.51.100.2');
    const k1 = redisMock.get.mock.calls[0]?.[0] as string;
    const k2 = redisMock.get.mock.calls[1]?.[0] as string;
    expect(k1).not.toEqual(k2); // one IP being throttled cannot lock the account elsewhere
    expect(k1).toContain('198.51.100.1');
    expect(k2).toContain('198.51.100.2');
  });

  it('clears the counter on success (del on the same key)', async () => {
    redisMock.del.mockResolvedValue(1);
    await svc.clear('a@b.c', '1.2.3.4');
    expect(redisMock.del).toHaveBeenCalledTimes(1);
    expect(redisMock.del.mock.calls[0]?.[0]).toContain('1.2.3.4');
  });
});
