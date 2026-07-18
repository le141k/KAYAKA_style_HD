import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageService } from './storage.service';
import type { AppConfig } from '../../config/configuration';

describe('StorageService — path containment', () => {
  let service: StorageService;

  beforeEach(() => {
    const config = { TELECOM_HD_UPLOAD_DIR: '/var/data/uploads' } as unknown as AppConfig;
    service = new StorageService(config);
  });

  it('rejects a storageKey that escapes the upload dir via ..', () => {
    expect(() => service.createReadStream('../../etc/passwd')).toThrow(BadRequestException);
  });

  it('rejects an absolute storageKey outside the upload dir', () => {
    expect(() => service.createReadStream('/etc/passwd')).toThrow(BadRequestException);
  });

  it('H8-6: rejects an empty / whitespace storageKey (would resolve to the root)', () => {
    expect(() => service.createReadStream('')).toThrow(BadRequestException);
    expect(() => service.createReadStream('   ')).toThrow(BadRequestException);
  });

  it('delete also refuses a traversal storageKey', async () => {
    await expect(service.delete('../../etc/passwd')).rejects.toThrow(BadRequestException);
  });

  it('accepts a normal in-dir storageKey (stream is lazy; no throw)', () => {
    // A valid key passing containment must NOT raise the BadRequestException guard.
    // createReadStream is lazy: the file is missing in the test, so attach an error
    // handler and destroy the stream to swallow the async ENOENT (not under test).
    let stream: ReturnType<StorageService['createReadStream']> | undefined;
    expect(() => {
      stream = service.createReadStream('tickets/42/uuid-file.txt');
    }).not.toThrow(BadRequestException);
    stream?.on('error', () => {});
    stream?.destroy();
  });
});

describe('StorageService — durable cleanup staging', () => {
  let uploadDir: string;
  let service: StorageService;

  beforeEach(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'attachment-storage-'));
    service = new StorageService({ TELECOM_HD_UPLOAD_DIR: uploadDir } as unknown as AppConfig);
  });

  afterEach(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  it('stages an attachment and restores it after a rolled-back DB delete', async () => {
    const originalKey = 'tickets/42/file.txt';
    await mkdir(join(uploadDir, 'tickets/42'), { recursive: true });
    await writeFile(join(uploadDir, originalKey), 'original bytes');

    const staged = await service.stageDelete(originalKey, 42);

    expect(staged).not.toBeNull();
    await expect(stat(join(uploadDir, originalKey))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.restoreStagedDelete(staged!.storageKey, originalKey);
    await expect(readFile(join(uploadDir, originalKey), 'utf8')).resolves.toBe('original bytes');
  });

  it('never overwrites an existing destination while recovering a staged delete', async () => {
    const originalKey = 'tickets/42/file.txt';
    await mkdir(join(uploadDir, 'tickets/42'), { recursive: true });
    await writeFile(join(uploadDir, originalKey), 'staged bytes');
    const staged = await service.stageDelete(originalKey, 42);
    await writeFile(join(uploadDir, originalKey), 'replacement bytes');

    await service.restoreStagedDelete(staged!.storageKey, originalKey);

    await expect(readFile(join(uploadDir, originalKey), 'utf8')).resolves.toBe('replacement bytes');
    await expect(stat(join(uploadDir, staged!.storageKey))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes only quarantine files older than the cutoff', async () => {
    const directory = join(uploadDir, 'quarantine');
    const stale = join(directory, 'stale.upload');
    const fresh = join(directory, 'fresh.upload');
    await mkdir(directory, { recursive: true });
    await writeFile(stale, 'old');
    await writeFile(fresh, 'newer');
    await utimes(stale, new Date(0), new Date(0));

    await expect(service.cleanupStaleQuarantine(new Date(Date.now() - 1_000))).resolves.toEqual({
      files: 1,
      bytes: 3,
    });
    await expect(readFile(fresh, 'utf8')).resolves.toBe('newer');
    await expect(unlink(fresh)).resolves.toBeUndefined();
  });

  it('bounds quarantine directory work even when entries are stale', async () => {
    const directory = join(uploadDir, 'quarantine');
    await mkdir(directory, { recursive: true });
    for (const name of ['one.upload', 'two.upload', 'three.upload']) {
      const path = join(directory, name);
      await writeFile(path, name);
      await utimes(path, new Date(0), new Date(0));
    }

    await expect(service.cleanupStaleQuarantine(new Date(Date.now() - 1_000), 1)).resolves.toMatchObject({
      files: 1,
    });
    const remaining = await readdir(directory);
    expect(remaining).toHaveLength(2);
  });
});
