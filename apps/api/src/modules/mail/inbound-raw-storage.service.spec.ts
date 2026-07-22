import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InboundRawStorageService } from './inbound-raw-storage.service';

const roots: string[] = [];

async function makeService() {
  const root = await mkdtemp(join(tmpdir(), 'inbound-raw-storage-'));
  roots.push(root);
  return new InboundRawStorageService({
    TELECOM_HD_UPLOAD_DIR: root,
    // Existing config is used; zero here only avoids coupling a filesystem unit test
    // to the host's available disk size.
    TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB: 0,
  } as never);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('InboundRawStorageService', () => {
  it('writes a complete private raw MIME file atomically and reads it back by opaque key', async () => {
    const service = await makeService();
    const source = Buffer.from([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x20, 0xff, 0x00]);
    const key = await service.write(source);
    expect(key).toMatch(/^inbound-raw\/[0-9a-f-]{36}\.eml$/);
    await expect(service.read(key)).resolves.toEqual(source);
    // The opaque key is stored inside the existing upload root, never a user-controlled path.
    expect(await readFile(join(roots[0]!, key))).toEqual(source);
  });

  it('rejects traversal-like keys and treats a second removal as idempotent', async () => {
    const service = await makeService();
    await expect(service.read('../secrets')).rejects.toThrow(/Invalid inbound raw storage key/i);
    const key = await service.write(Buffer.from('message'));
    await service.remove(key);
    await expect(service.remove(key)).resolves.toBeUndefined();
  });

  it('reports safe capacity telemetry without exposing a filesystem path', async () => {
    const service = await makeService();
    const capacity = await service.capacity();
    expect(capacity.availableBytes).toBeGreaterThan(0n);
    expect(capacity.reserveBytes).toBe(0n);
  });

  it('keeps a pre-commit marker until the ledger pointer is committed, then removes only the marker', async () => {
    const service = await makeService();
    const key = await service.write(Buffer.from('durable raw'));
    const pending = await service.listPending(10, new Date(Date.now() + 1_000));
    expect(pending).toEqual([key]);

    await service.commit(key);
    await expect(service.read(key)).resolves.toEqual(Buffer.from('durable raw'));
    await expect(service.listPending(10, new Date(Date.now() + 1_000))).resolves.toEqual([]);
  });

  it('does not leak a filesystem path through a storage-read failure', async () => {
    const service = await makeService();
    const missing = 'inbound-raw/00000000-0000-4000-8000-000000000099.eml';
    let error: Error | undefined;
    try {
      await service.read(missing);
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toBe('Inbound raw MIME storage is unavailable');
    expect(error?.message).not.toContain(roots[0]!);
  });
});
