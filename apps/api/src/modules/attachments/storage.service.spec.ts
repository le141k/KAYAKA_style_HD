import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
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
