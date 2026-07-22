import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';

/**
 * Private durable storage for large inbound raw MIME. It deliberately uses the
 * existing uploads volume and reserve setting rather than adding an unreviewed
 * object-store/config dependency. Keys are opaque and never exposed by the API.
 */
@Injectable()
export class InboundRawStorageService {
  private static readonly PREFIX = 'inbound-raw';
  private static readonly PENDING_DIR = '.pending';
  private readonly root: string;
  private readonly pendingRoot: string;
  private readonly logger = new Logger(InboundRawStorageService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.root = resolve(config.TELECOM_HD_UPLOAD_DIR, InboundRawStorageService.PREFIX);
    this.pendingRoot = join(this.root, InboundRawStorageService.PENDING_DIR);
  }

  /** Allocate an opaque key before writing so the database can fence the staging lifecycle. */
  allocateKey(): string {
    return `${InboundRawStorageService.PREFIX}/${randomUUID()}.eml`;
  }

  async write(bytes: Buffer, storageKey = this.allocateKey()): Promise<string> {
    await this.assertCapacity(bytes.length);
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.pendingRoot, { recursive: true, mode: 0o700 });
    const id = this.idFromStorageKey(storageKey);
    const destination = this.pathFor(storageKey);
    const pending = this.pendingPathFor(storageKey);
    const temporary = join(this.root, `.${id}.${randomUUID()}.tmp`);
    let handle: FileHandle | undefined;
    let pendingHandle: FileHandle | undefined;
    try {
      // The durable pending marker is written BEFORE the raw file. If this process crashes
      // between the atomic rename and ledger INSERT, the bounded reaper can prove whether the
      // pointer was committed and remove only an unreferenced orphan. A marker is harmless when
      // a DB commit succeeds but the final marker removal is interrupted.
      pendingHandle = await fs.open(pending, 'wx', 0o600);
      await pendingHandle.sync();
      await pendingHandle.close();
      pendingHandle = undefined;
      await this.syncDirectory(this.pendingRoot);
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Atomic on the same filesystem: readers see either the complete message or no key.
      await fs.rename(temporary, destination);
      await this.syncDirectory(dirname(destination));
      return storageKey;
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await pendingHandle?.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
      await this.unlinkIfPresent(pending).catch(() => undefined);
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Inbound raw MIME write failed (${this.errorKind(err)})`);
      throw new ServiceUnavailableException('Inbound raw MIME storage write failed');
    }
  }

  /** Mark a successfully committed ledger pointer as durable; marker cleanup is safe to retry. */
  async commit(storageKey: string): Promise<void> {
    try {
      await this.unlinkIfPresent(this.pendingPathFor(storageKey));
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Inbound raw MIME marker commit failed (${this.errorKind(err)})`);
      throw new ServiceUnavailableException('Inbound raw MIME storage marker update failed');
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.pathFor(storageKey));
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Inbound raw MIME read failed (${this.errorKind(err)})`);
      throw new ServiceUnavailableException('Inbound raw MIME storage is unavailable');
    }
  }

  /** Idempotent cleanup; a missing file is already a completed cleanup. */
  async remove(storageKey: string): Promise<void> {
    try {
      await this.unlinkIfPresent(this.pathFor(storageKey));
      await this.unlinkIfPresent(this.pendingPathFor(storageKey));
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Inbound raw MIME cleanup failed (${this.errorKind(err)})`);
      throw new ServiceUnavailableException('Inbound raw MIME storage cleanup failed');
    }
  }

  /**
   * Return at most `limit` stale, pre-commit markers. The scanner only opens the dedicated
   * marker directory, never enumerates the (potentially large) MIME directory. Callers must
   * prove that no ledger pointer references a key before deleting its file.
   */
  async listPending(limit: number, olderThan: Date): Promise<string[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ServiceUnavailableException('Invalid inbound raw storage pending-cleanup limit');
    }
    try {
      await fs.mkdir(this.pendingRoot, { recursive: true, mode: 0o700 });
      const dir = await fs.opendir(this.pendingRoot);
      const keys: string[] = [];
      try {
        for await (const entry of dir) {
          if (!entry.isFile() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
          const marker = join(this.pendingRoot, entry.name);
          const stat = await fs.stat(marker);
          if (stat.mtime > olderThan) continue;
          keys.push(`${InboundRawStorageService.PREFIX}/${entry.name}.eml`);
          if (keys.length >= limit) break;
        }
      } finally {
        await dir.close().catch(() => undefined);
      }
      return keys;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Inbound raw MIME pending-marker scan failed (${this.errorKind(err)})`);
      throw new ServiceUnavailableException('Cannot inspect inbound raw MIME pending storage');
    }
  }

  /**
   * Return only safe capacity telemetry for the operator health endpoint.  The
   * caller receives byte counts as strings (rather than BigInt) so this can be
   * returned through any JSON boundary without a serializer-dependent failure.
   * A failed capacity proof remains fail-closed for writes; health treats it as
   * an explicit warning rather than pretending the volume is healthy.
   */
  async capacity(): Promise<{ availableBytes: bigint; reserveBytes: bigint }> {
    try {
      await fs.mkdir(this.config.TELECOM_HD_UPLOAD_DIR, { recursive: true, mode: 0o700 });
      const stat = await fs.statfs(this.config.TELECOM_HD_UPLOAD_DIR, { bigint: true });
      return {
        availableBytes: stat.bavail * stat.bsize,
        reserveBytes: BigInt(this.config.TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB) * 1024n * 1024n,
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Inbound raw MIME capacity probe failed (${this.errorKind(err)})`);
      throw new ServiceUnavailableException('Cannot verify inbound raw MIME storage capacity');
    }
  }

  private pathFor(storageKey: string): string {
    if (!/^inbound-raw\/[0-9a-f-]{36}\.eml$/i.test(storageKey)) {
      throw new ServiceUnavailableException('Invalid inbound raw storage key');
    }
    const path = resolve(this.config.TELECOM_HD_UPLOAD_DIR, storageKey);
    if (path !== this.root && !path.startsWith(`${this.root}${sep}`)) {
      throw new ServiceUnavailableException('Inbound raw storage key escapes its root');
    }
    return path;
  }

  private pendingPathFor(storageKey: string): string {
    const path = this.pathFor(storageKey);
    const id = path.slice(this.root.length + 1, -'.eml'.length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new ServiceUnavailableException('Invalid inbound raw storage key');
    }
    return join(this.pendingRoot, id);
  }

  private idFromStorageKey(storageKey: string): string {
    const path = this.pathFor(storageKey);
    const id = path.slice(this.root.length + 1, -'.eml'.length);
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      throw new ServiceUnavailableException('Invalid inbound raw storage key');
    }
    return id;
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await fs.unlink(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  private async assertCapacity(incomingBytes: number): Promise<void> {
    const { availableBytes, reserveBytes } = await this.capacity();
    if (availableBytes - BigInt(incomingBytes) < reserveBytes) {
      throw new ServiceUnavailableException('Inbound raw MIME storage reserve would be exceeded');
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    // Directory fsync is best-effort on platforms/filesystems that do not allow opening a
    // directory. The file itself was fsynced before rename, which is the critical guarantee.
    try {
      const handle = await fs.open(path, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Do not convert a successfully atomic write into a failed delivery solely because a
      // platform lacks directory fsync. The temp file was durable before rename.
    }
  }

  private errorKind(err: unknown): string {
    return err instanceof Error && err.name ? err.name.slice(0, 80) : 'UnknownError';
  }
}
