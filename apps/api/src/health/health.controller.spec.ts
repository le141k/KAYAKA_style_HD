import { HttpException, HttpStatus } from '@nestjs/common';
import { HealthController } from './health.controller';
import type { PrismaService } from '../prisma/prisma.service';
import type { AppConfig } from '../config/configuration';
import { APP_CONFIG } from '../config/configuration';
import { vi, describe, it, expect, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal fakes — no real DB or Redis connections
// ---------------------------------------------------------------------------

const fakeConfig = {
  REDIS_URL: 'redis://localhost:6379',
} as AppConfig;

// Shared mock Redis instance so tests can mutate it between cases.
const mockRedisInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  ping: vi.fn().mockResolvedValue('PONG'),
};

vi.mock('ioredis', () => ({
  default: vi.fn(() => mockRedisInstance),
}));

// Suppress APP_CONFIG import — we never actually use the token in direct instantiation.
void APP_CONFIG;

function makePrisma(overrides: { $queryRaw?: ReturnType<typeof vi.fn> } = {}): PrismaService {
  return {
    $queryRaw: overrides.$queryRaw ?? vi.fn().mockResolvedValue([{ '?column?': 1 }]),
  } as unknown as PrismaService;
}

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(() => {
    mockRedisInstance.connect.mockResolvedValue(undefined);
    mockRedisInstance.on.mockReturnValue(undefined);
    mockRedisInstance.ping.mockResolvedValue('PONG');

    controller = new HealthController(makePrisma(), fakeConfig);
  });

  it('returns { status:"ok", db:"up", redis:"up" } when both are healthy', async () => {
    const result = await controller.check();
    expect(result).toEqual({ status: 'ok', db: 'up', redis: 'up' });
  });

  it('throws 503 with db:"down" when Prisma query rejects', async () => {
    controller = new HealthController(
      makePrisma({ $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')) }),
      fakeConfig,
    );

    let caught: HttpException | undefined;
    try {
      await controller.check();
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect(caught!.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    const body = caught!.getResponse() as { db: string; redis: string; status: string };
    expect(body.db).toBe('down');
    expect(body.status).toBe('error');
  });

  it('throws 503 with redis:"down" when ping fails', async () => {
    // Patch the private redis field on the already-constructed controller.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).redis = {
      ping: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };

    let caught: HttpException | undefined;
    try {
      await controller.check();
    } catch (err) {
      caught = err as HttpException;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect(caught!.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    const body = caught!.getResponse() as { redis: string; status: string };
    expect(body.redis).toBe('down');
    expect(body.status).toBe('error');
  });
});
