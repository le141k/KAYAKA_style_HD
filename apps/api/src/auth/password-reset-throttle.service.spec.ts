import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException, ServiceUnavailableException } from '@nestjs/common';

const { redisMock } = vi.hoisted(() => ({
  redisMock: {
    eval: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('ioredis', () => ({ default: vi.fn(() => redisMock) }));

import { PasswordResetThrottleService } from './password-reset-throttle.service';
import type { AppConfig } from '../config/configuration';

function config(nodeEnv: 'test' | 'production'): AppConfig {
  return {
    NODE_ENV: nodeEnv,
    REDIS_URL: 'redis://localhost:6379',
    TELECOM_HD_JWT_ACCESS_SECRET: 'reset-quota-test-secret-at-least-32-characters',
  } as AppConfig;
}

describe('PasswordResetThrottleService', () => {
  beforeEach(() => {
    redisMock.eval.mockReset().mockResolvedValue([1, 1, 1]);
    redisMock.connect.mockClear();
    redisMock.quit.mockClear();
  });

  it('atomically consumes global, normalized-identity and IP quotas without raw identifiers', async () => {
    const service = new PasswordResetThrottleService(config('production'));

    await service.consume('  Victim@Example.COM ', '203.0.113.9');

    expect(redisMock.eval).toHaveBeenCalledTimes(1);
    const args = redisMock.eval.mock.calls[0] as unknown[];
    expect(args[1]).toBe(3);
    const serialized = JSON.stringify(args);
    expect(serialized).not.toContain('Victim@Example.COM');
    expect(serialized).not.toContain('victim@example.com');
    expect(serialized).not.toContain('203.0.113.9');
    expect(serialized).toContain('th:password-reset:global');
  });

  it('returns a generic 429 when any quota is exceeded', async () => {
    redisMock.eval.mockResolvedValue([1, 4, 1]);
    const service = new PasswordResetThrottleService(config('production'));

    await expect(service.consume('victim@example.com', '203.0.113.9')).rejects.toBeInstanceOf(HttpException);
  });

  it('fails closed in production when Redis is unavailable', async () => {
    redisMock.eval.mockRejectedValue(new Error('redis down'));
    const service = new PasswordResetThrottleService(config('production'));

    await expect(service.consume('victim@example.com', '203.0.113.9')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('fails open outside production so local development is not coupled to Redis', async () => {
    redisMock.eval.mockRejectedValue(new Error('redis down'));
    const service = new PasswordResetThrottleService(config('test'));

    await expect(service.consume('victim@example.com', '203.0.113.9')).resolves.toBeUndefined();
  });
});
