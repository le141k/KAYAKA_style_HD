import { ServiceUnavailableException } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration';
import { AttachmentCapacityService } from './attachment-capacity.service';

const MIB = 1024 * 1024;

function harness(snapshot = { _count: { _all: 0 }, _sum: { size: 0 as number | null } }) {
  const order: string[] = [];
  const attachment = {
    aggregate: vi.fn().mockImplementation(async () => {
      order.push('aggregate');
      return snapshot;
    }),
  };
  const tx = {
    attachment,
    $queryRaw: vi.fn().mockImplementation(async () => {
      order.push('lock');
      return [{ pg_advisory_xact_lock: null }];
    }),
  };
  const prisma = {
    attachment,
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const config = {
    TELECOM_HD_UPLOAD_DIR: '/tmp',
    TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB: 5120,
    TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT: 2000,
    TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB: 2048,
  } as AppConfig;
  return {
    attachment,
    config,
    order,
    prisma,
    service: new AttachmentCapacityService(prisma as never, config),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('AttachmentCapacityService', () => {
  it('accepts the exact count and byte boundaries', async () => {
    const incoming = 10 * MIB;
    const { service } = harness({
      _count: { _all: 1999 },
      _sum: { size: 2048 * MIB - incoming },
    });
    vi.spyOn(fs, 'statfs').mockResolvedValue({
      bavail: BigInt(5120 * MIB + incoming),
      bsize: 1n,
    } as never);

    await expect(service.assertCanAccept(incoming, 1)).resolves.toBeUndefined();
  });

  it('fails closed one row above the absolute orphan-count cap', async () => {
    const { service } = harness({ _count: { _all: 2000 }, _sum: { size: 0 } });
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 20_000n * BigInt(MIB), bsize: 1n } as never);

    await expect(service.assertCanAccept(1, 1)).rejects.toThrow(ServiceUnavailableException);
  });

  it('fails closed one byte above the absolute orphan-byte cap', async () => {
    const { service } = harness({
      _count: { _all: 1 },
      _sum: { size: 2048 * MIB },
    });
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 20_000n * BigInt(MIB), bsize: 1n } as never);

    await expect(service.assertCanAccept(1, 1)).rejects.toThrow(ServiceUnavailableException);
  });

  it('fails closed when the incoming write would cross the free-disk reserve', async () => {
    const { service } = harness();
    vi.spyOn(fs, 'statfs').mockResolvedValue({
      bavail: BigInt(5120 * MIB + 99),
      bsize: 1n,
    } as never);

    await expect(service.assertCanAccept(100, 1)).rejects.toThrow(ServiceUnavailableException);
  });

  it('takes the transaction advisory lock before the authoritative snapshot and operation', async () => {
    const { service, order } = harness();
    vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 20_000n * BigInt(MIB), bsize: 1n } as never);

    await service.withOrphanCapacity(100, 1, async () => {
      order.push('operation');
      return undefined;
    });

    expect(order).toEqual(['lock', 'aggregate', 'operation']);
  });

  it('does not double-charge bytes that are already on the quarantine filesystem', async () => {
    const { service } = harness();
    vi.spyOn(fs, 'statfs').mockResolvedValue({
      bavail: BigInt(5120 * MIB),
      bsize: 1n,
    } as never);

    await expect(service.withOrphanCapacity(25 * MIB, 1, async () => undefined)).resolves.toBeUndefined();
  });

  it('does not subtract quarantined request bytes a second time during early DB-capacity recheck', async () => {
    const { service } = harness();
    vi.spyOn(fs, 'statfs').mockResolvedValue({
      bavail: BigInt(5120 * MIB),
      bsize: 1n,
    } as never);

    await expect(service.assertCanAccept(25 * MIB, 1, 0)).resolves.toBeUndefined();
  });
});
