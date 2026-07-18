import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { createConnection, Socket } from 'node:net';
import { once } from 'node:events';
import { APP_CONFIG, AppConfig } from '../config/configuration';

const MAX_RESPONSE_BYTES = 4096;
const MAX_CONCURRENT_SCANS = 2;
const MAX_QUEUED_SCANS = 8;
const SIGNATURE_CACHE_MS = 5 * 60_000;
const MAX_SIGNATURE_AGE_MS = 72 * 60 * 60_000;

/** Streams quarantined bytes to clamd using its INSTREAM protocol; scanner errors fail closed. */
@Injectable()
export class ClamAvService {
  private activeScans = 0;
  private readonly scanWaiters: Array<() => void> = [];
  private signatureCheckedAt = 0;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async scanFile(filePath: string): Promise<void> {
    if (!this.config.TELECOM_HD_CLAMAV_ENABLED) {
      if (this.config.NODE_ENV === 'production') {
        throw new ServiceUnavailableException('Attachment scanner is unavailable');
      }
      return;
    }

    await this.acquireScanSlot();
    let verdict: string;
    try {
      await this.assertFreshSignatures();
      verdict = await this.streamToClamd(filePath);
    } catch {
      throw new ServiceUnavailableException('Attachment scanner is unavailable');
    } finally {
      this.releaseScanSlot();
    }
    const normalized = verdict.replace(/[\0\r\n]+$/g, '').trim();
    if (/^stream: .+ FOUND$/.test(normalized)) {
      throw new BadRequestException('Attachment rejected by malware scanner');
    }
    if (normalized !== 'stream: OK') {
      throw new ServiceUnavailableException('Attachment scanner returned an invalid verdict');
    }
  }

  private async acquireScanSlot(): Promise<void> {
    if (this.activeScans < MAX_CONCURRENT_SCANS) {
      this.activeScans += 1;
      return;
    }
    if (this.scanWaiters.length >= MAX_QUEUED_SCANS) {
      throw new ServiceUnavailableException('Attachment scanner is busy');
    }
    await new Promise<void>((resolve) => this.scanWaiters.push(resolve));
  }

  private releaseScanSlot(): void {
    const next = this.scanWaiters.shift();
    if (next) next();
    else this.activeScans -= 1;
  }

  private async assertFreshSignatures(): Promise<void> {
    if (Date.now() - this.signatureCheckedAt < SIGNATURE_CACHE_MS) return;
    const version = (await this.sendCommand('zVERSION\0')).replace(/[\0\r\n]+$/g, '').trim();
    const match = /^ClamAV [^/]+\/\d+\/(.+)$/.exec(version);
    const signatureTime = match?.[1] ? Date.parse(match[1]) : Number.NaN;
    const age = Date.now() - signatureTime;
    if (!Number.isFinite(signatureTime) || age < -60 * 60_000 || age > MAX_SIGNATURE_AGE_MS) {
      throw new Error('clamd signatures are stale');
    }
    this.signatureCheckedAt = Date.now();
  }

  private async streamToClamd(filePath: string): Promise<string> {
    const socket = createConnection({
      host: this.config.TELECOM_HD_CLAMAV_HOST,
      port: this.config.TELECOM_HD_CLAMAV_PORT,
    });
    socket.setTimeout(this.config.TELECOM_HD_CLAMAV_TIMEOUT_MS);
    socket.once('timeout', () => socket.destroy(new Error('clamd timeout')));

    try {
      await once(socket, 'connect');
      if (!socket.write('zINSTREAM\0')) await once(socket, 'drain');
      for await (const chunk of createReadStream(filePath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const size = Buffer.allocUnsafe(4);
        size.writeUInt32BE(bytes.length, 0);
        if (!socket.write(size)) await once(socket, 'drain');
        if (!socket.write(bytes)) await once(socket, 'drain');
      }
      if (!socket.write(Buffer.alloc(4))) await once(socket, 'drain');
      return await this.readVerdict(socket);
    } finally {
      socket.destroy();
    }
  }

  private async sendCommand(command: string): Promise<string> {
    const socket = createConnection({
      host: this.config.TELECOM_HD_CLAMAV_HOST,
      port: this.config.TELECOM_HD_CLAMAV_PORT,
    });
    socket.setTimeout(this.config.TELECOM_HD_CLAMAV_TIMEOUT_MS);
    socket.once('timeout', () => socket.destroy(new Error('clamd timeout')));
    try {
      await once(socket, 'connect');
      if (!socket.write(command)) await once(socket, 'drain');
      return await this.readVerdict(socket);
    } finally {
      socket.destroy();
    }
  }

  private readVerdict(socket: Socket): Promise<string> {
    return new Promise((resolve, reject) => {
      let response = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else if (response.length === 0) reject(new Error('empty clamd response'));
        else resolve(response.toString('utf8'));
      };
      socket.on('data', (chunk: Buffer) => {
        response = Buffer.concat([response, chunk]);
        if (response.length > MAX_RESPONSE_BYTES) {
          finish(new Error('clamd response too large'));
          return;
        }
        if (response.includes(0) || response.includes(10)) finish();
      });
      socket.once('error', (error) => finish(error));
      socket.once('end', finish);
    });
  }
}
