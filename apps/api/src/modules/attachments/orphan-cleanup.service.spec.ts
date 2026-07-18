import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/configuration';
import type { PrismaService } from '../../prisma/prisma.service';
import { OrphanCleanupService } from './orphan-cleanup.service';
import type { StorageService } from './storage.service';

function makeHarness(configOverrides: Partial<AppConfig> = {}) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ id: 1 }]),
    attachment: {
      findFirst: vi.fn().mockResolvedValue({
        id: 1,
        storageKey: 'orphan/file.txt',
        size: 12,
      }),
      delete: vi.fn().mockResolvedValue({ id: 1 }),
    },
  };
  const prisma = {
    attachment: {
      findMany: vi.fn().mockResolvedValue([{ id: 1 }]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const storage = {
    listStagedDeletes: vi.fn().mockResolvedValue([]),
    cleanupStaleQuarantine: vi.fn().mockResolvedValue({ files: 0, bytes: 0 }),
    stageDelete: vi.fn().mockResolvedValue({
      attachmentId: 1,
      storageKey: '.deletion-queue/1-00000000-0000-4000-8000-000000000000.pending',
    }),
    restoreStagedDelete: vi.fn().mockResolvedValue(undefined),
    finalizeStagedDelete: vi.fn().mockResolvedValue(undefined),
  };
  const config = {
    NODE_ENV: 'test',
    TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS: 24,
    TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT: 2000,
    TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS: 1000,
    TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS: 120,
    ...configOverrides,
  } as unknown as AppConfig;
  const service = new OrphanCleanupService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    config,
  );
  return { service, prisma, storage, tx };
}

describe('OrphanCleanupService', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('stages bytes, deletes the locked row, then finalizes after commit', async () => {
    await expect(harness.service.cleanup()).resolves.toEqual({ rows: 1, bytes: 12 });

    expect(harness.tx.$queryRaw).toHaveBeenCalledOnce();
    expect(harness.storage.stageDelete).toHaveBeenCalledWith('orphan/file.txt', 1);
    expect(harness.tx.attachment.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    expect(harness.storage.finalizeStagedDelete).toHaveBeenCalledOnce();
    expect(harness.storage.restoreStagedDelete).not.toHaveBeenCalled();
  });

  it('restores staged bytes when the DB transaction rolls back', async () => {
    harness.tx.attachment.delete.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(harness.service.cleanup()).rejects.toThrow('database unavailable');

    expect(harness.storage.restoreStagedDelete).toHaveBeenCalledWith(
      '.deletion-queue/1-00000000-0000-4000-8000-000000000000.pending',
      'orphan/file.txt',
    );
    expect(harness.storage.finalizeStagedDelete).not.toHaveBeenCalled();
  });

  it('recovers interrupted cleanup before processing new candidates', async () => {
    harness.storage.listStagedDeletes.mockResolvedValueOnce([
      {
        attachmentId: 7,
        storageKey: '.deletion-queue/7-00000000-0000-4000-8000-000000000000.pending',
      },
      {
        attachmentId: 8,
        storageKey: '.deletion-queue/8-00000000-0000-4000-8000-000000000000.pending',
      },
    ]);
    harness.prisma.attachment.findUnique
      .mockResolvedValueOnce({ storageKey: 'orphan/existing.txt' })
      .mockResolvedValueOnce(null);
    harness.prisma.attachment.findMany.mockResolvedValueOnce([]);

    await expect(harness.service.cleanup()).resolves.toEqual({ rows: 0, bytes: 0 });

    expect(harness.storage.restoreStagedDelete).toHaveBeenCalledWith(
      '.deletion-queue/7-00000000-0000-4000-8000-000000000000.pending',
      'orphan/existing.txt',
    );
    expect(harness.storage.finalizeStagedDelete).toHaveBeenCalledWith(
      '.deletion-queue/8-00000000-0000-4000-8000-000000000000.pending',
    );
  });

  it('drains repeated batches in one bounded run instead of stopping at one batch', async () => {
    harness = makeHarness({ TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS: 300 });
    const firstBatch = Array.from({ length: 250 }, (_, index) => ({ id: index + 1 }));
    harness.prisma.attachment.findMany.mockResolvedValueOnce(firstBatch).mockResolvedValueOnce([{ id: 251 }]);
    await expect(harness.service.cleanup()).resolves.toEqual({ rows: 251, bytes: 3012 });

    expect(harness.prisma.attachment.findMany).toHaveBeenCalledTimes(2);
    expect(harness.storage.cleanupStaleQuarantine).toHaveBeenCalledWith(
      expect.any(Date),
      300,
      expect.any(Number),
    );
  });
});
