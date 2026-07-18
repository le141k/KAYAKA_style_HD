import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/configuration';
import { ClamAvService } from './clamav.service';

describe('ClamAvService', () => {
  let server: Server | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    server = undefined;
    tempDir = undefined;
  });

  async function scanner(verdict: string, signatureTime = new Date()): Promise<ClamAvService> {
    server = createServer((socket) => {
      let input = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        input = Buffer.concat([input, chunk]);
        const versionCommand = Buffer.from('zVERSION\0');
        if (
          input.length >= versionCommand.length &&
          input.subarray(0, versionCommand.length).equals(versionCommand)
        ) {
          socket.end(`ClamAV 1.5.3/12345/${signatureTime.toUTCString()}\0`);
          return;
        }
        const commandLength = Buffer.byteLength('zINSTREAM\0');
        if (input.length < commandLength || input.subarray(0, commandLength).toString() !== 'zINSTREAM\0') {
          return;
        }
        let offset = commandLength;
        while (input.length >= offset + 4) {
          const length = input.readUInt32BE(offset);
          offset += 4;
          if (length === 0) {
            socket.end(`${verdict}\0`);
            return;
          }
          if (input.length < offset + length) return;
          offset += length;
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test scanner did not bind');
    return new ClamAvService({
      NODE_ENV: 'production',
      TELECOM_HD_CLAMAV_ENABLED: true,
      TELECOM_HD_CLAMAV_HOST: '127.0.0.1',
      TELECOM_HD_CLAMAV_PORT: address.port,
      TELECOM_HD_CLAMAV_TIMEOUT_MS: 1_000,
    } as AppConfig);
  }

  async function sampleFile(): Promise<string> {
    tempDir = await mkdtemp(join(tmpdir(), 'clamav-test-'));
    const path = join(tempDir, 'sample.bin');
    await writeFile(path, 'test bytes');
    return path;
  }

  it('is a no-op only for non-production profiles when disabled', async () => {
    const config = {
      NODE_ENV: 'test',
      TELECOM_HD_CLAMAV_ENABLED: false,
      TELECOM_HD_PUBLIC_UPLOAD_ENABLED: true,
    } as AppConfig;
    await expect(new ClamAvService(config).scanFile('/missing')).resolves.toBeUndefined();
  });

  it('fails closed when public uploads are enabled in production without a scanner', async () => {
    const config = {
      NODE_ENV: 'production',
      TELECOM_HD_CLAMAV_ENABLED: false,
      TELECOM_HD_PUBLIC_UPLOAD_ENABLED: true,
    } as AppConfig;
    await expect(new ClamAvService(config).scanFile('/missing')).rejects.toThrow(ServiceUnavailableException);
  });

  it('accepts a strict clean verdict from a scanner with fresh signatures', async () => {
    const service = await scanner('stream: OK');
    await expect(service.scanFile(await sampleFile())).resolves.toBeUndefined();
  });

  it('accepts canonical verdicts with mixed protocol line terminators', async () => {
    const service = await scanner('stream: OK\0\r\n');
    await expect(service.scanFile(await sampleFile())).resolves.toBeUndefined();
  });

  it('rejects an EICAR-style FOUND verdict', async () => {
    const service = await scanner('stream: Win.Test.EICAR_HDB-1 FOUND');
    await expect(service.scanFile(await sampleFile())).rejects.toThrow(BadRequestException);
  });

  it('fails closed before scanning when signature data is stale', async () => {
    const stale = new Date(Date.now() - 4 * 24 * 60 * 60_000);
    const service = await scanner('stream: OK', stale);
    await expect(service.scanFile(await sampleFile())).rejects.toThrow(ServiceUnavailableException);
  });

  it('fails closed on a non-canonical scanner verdict', async () => {
    const service = await scanner('stream: BROKEN OK');
    await expect(service.scanFile(await sampleFile())).rejects.toThrow(ServiceUnavailableException);
  });
});
