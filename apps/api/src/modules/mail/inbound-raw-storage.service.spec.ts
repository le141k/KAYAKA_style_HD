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

  it('publishes a fenced write only when its caller grants the atomic rename capability', async () => {
    const service = await makeService();
    const key = service.allocateKey();
    const source = Buffer.from('fenced raw MIME');
    let callbackRan = false;

    await service.writeFenced(source, key, async (publish) => {
      // The temporary file is private: a reaper/reader cannot observe a partially written
      // destination before the caller has obtained its durable DB staging lock.
      await expect(service.read(key)).rejects.toThrow(/unavailable/i);
      await publish();
      callbackRan = true;
    });

    expect(callbackRan).toBe(true);
    await expect(service.read(key)).resolves.toEqual(source);
  });

  it('retains the marker and published bytes when the caller rolls back after publish', async () => {
    const service = await makeService();
    const key = service.allocateKey();
    const source = Buffer.from('rollback-recovery raw MIME');

    await expect(
      service.writeFenced(source, key, async (publish) => {
        await publish();
        throw new Error('simulated transaction rollback');
      }),
    ).rejects.toThrow(/storage write failed/i);

    // The staging state/reaper, not this storage helper, owns recovery after publication. If we
    // hid the marker here, a durable ACTIVE/REAPING reservation could no longer prove cleanup.
    await expect(service.read(key)).resolves.toEqual(source);
    await expect(service.listPending(10, new Date(Date.now() + 1_000))).resolves.toEqual([key]);
  });

  it('does not publish bytes when a stale writer loses its fence before rename', async () => {
    const service = await makeService();
    const key = service.allocateKey();

    await expect(
      service.writeFenced(Buffer.from('must remain private'), key, async () => {
        throw new Error('stage is already REAPING');
      }),
    ).rejects.toThrow(/storage write failed/i);

    await expect(service.read(key)).rejects.toThrow(/unavailable/i);
    await expect(service.listPending(10, new Date(Date.now() + 1_000))).resolves.toEqual([]);
  });

  it('removes the deterministic pre-publish temp file during staged cleanup', async () => {
    const service = await makeService();
    const key = service.allocateKey();
    const id = key.slice('inbound-raw/'.length, -'.eml'.length);
    let entered!: () => void;
    const enteredFence = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let abortFence!: (reason: Error) => void;
    const holdFence = new Promise<void>((_resolve, reject) => {
      abortFence = reject;
    });
    const writer = service.writeFenced(Buffer.from('private pre-publish bytes'), key, async () => {
      entered();
      await holdFence;
    });

    await enteredFence;
    const stagingTemp = join(roots[0]!, 'inbound-raw', '.staging', `${id}.tmp`);
    await expect(readFile(stagingTemp)).resolves.toEqual(Buffer.from('private pre-publish bytes'));

    await service.removeFile(key);
    await expect(readFile(stagingTemp)).rejects.toMatchObject({ code: 'ENOENT' });
    abortFence(new Error('simulated stale writer abort'));
    await expect(writer).rejects.toThrow(/storage write failed/i);
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
