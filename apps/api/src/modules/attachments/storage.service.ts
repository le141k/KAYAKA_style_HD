import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

export interface StagedAttachmentDeletion {
  attachmentId: number;
  storageKey: string;
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /**
   * Write a buffer to disk under `<uploadDir>/<subdir>/<uuid>-<filename>`.
   * Returns the storageKey (relative path inside uploadDir).
   */
  async write(
    subdir: string,
    filename: string,
    buffer: Buffer,
  ): Promise<{ storageKey: string; sha1: string }> {
    const uploadDir = this.config.TELECOM_HD_UPLOAD_DIR;
    const dirPath = join(uploadDir, subdir);
    await fs.mkdir(dirPath, { recursive: true });

    const uuid = randomUUID();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const keyRelative = join(subdir, `${uuid}-${safeName}`);
    const fullPath = join(uploadDir, keyRelative);

    await fs.writeFile(fullPath, buffer);

    const sha1 = createHash('sha1').update(buffer).digest('hex');
    this.logger.debug('Stored attachment bytes');

    return { storageKey: keyRelative, sha1 };
  }

  /** Move a scanned quarantine file into permanent storage without buffering it in Node. */
  async adoptQuarantined(
    subdir: string,
    filename: string,
    quarantinePath: string,
  ): Promise<{ storageKey: string; sha1: string }> {
    const uploadDir = this.config.TELECOM_HD_UPLOAD_DIR;
    const dirPath = join(uploadDir, subdir);
    await fs.mkdir(dirPath, { recursive: true });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const keyRelative = join(subdir, `${randomUUID()}-${safeName}`);
    const fullPath = join(uploadDir, keyRelative);
    const sha1 = await this.hashFile(quarantinePath);
    try {
      await fs.rename(quarantinePath, fullPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.copyFile(quarantinePath, fullPath);
      await fs.unlink(quarantinePath);
    }
    await fs.chmod(fullPath, 0o600);
    this.logger.debug('Adopted scanned attachment bytes');
    return { storageKey: keyRelative, sha1 };
  }

  /** Absolute, traversal-safe path for reconciliation/scanning of a DB-owned storage key. */
  pathForKey(storageKey: string): string {
    return this.resolveWithinUploadDir(storageKey);
  }

  private async hashFile(filePath: string): Promise<string> {
    const hash = createHash('sha1');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  /**
   * Resolve a storageKey to an absolute path and assert it stays inside the
   * upload dir. storageKeys are DB-sourced (our own uuid names), so this is
   * defense-in-depth against a poisoned/legacy row containing `..` or an
   * absolute path — never let a read/delete escape the upload root.
   */
  private resolveWithinUploadDir(storageKey: string): string {
    // H8-6: an empty/whitespace key resolves to the upload root itself (rel === '')
    // which passes the `..`/absolute check — reject it explicitly.
    if (!storageKey || !storageKey.trim()) {
      throw new BadRequestException('Invalid storage key');
    }
    const root = resolve(this.config.TELECOM_HD_UPLOAD_DIR);
    const fullPath = resolve(root, storageKey);
    const rel = relative(root, fullPath);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new BadRequestException('Invalid storage key');
    }
    return fullPath;
  }

  /** Open a read stream for an existing storageKey. */
  createReadStream(storageKey: string): ReadStream {
    return createReadStream(this.resolveWithinUploadDir(storageKey));
  }

  /** Delete a file by storageKey. Silently ignores missing files. */
  async delete(storageKey: string): Promise<void> {
    const fullPath = this.resolveWithinUploadDir(storageKey);
    try {
      await fs.unlink(fullPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /** Atomically move bytes out of downloadable storage before deleting their DB row. */
  async stageDelete(storageKey: string, attachmentId: number): Promise<StagedAttachmentDeletion | null> {
    const source = this.resolveWithinUploadDir(storageKey);
    const directory = join(this.config.TELECOM_HD_UPLOAD_DIR, '.deletion-queue');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const pendingKey = join('.deletion-queue', `${attachmentId}-${randomUUID()}.pending`);
    try {
      await fs.rename(source, this.resolveWithinUploadDir(pendingKey));
      return { attachmentId, storageKey: pendingKey };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /** Restore a staged file when the corresponding DB transaction did not commit. */
  async restoreStagedDelete(stagedKey: string, originalKey: string): Promise<void> {
    this.assertDeletionQueueKey(stagedKey);
    const staged = this.resolveWithinUploadDir(stagedKey);
    const original = this.resolveWithinUploadDir(originalKey);
    await fs.mkdir(dirname(original), { recursive: true });
    try {
      // link() is atomic and, unlike rename() on POSIX, never overwrites an
      // existing destination. Both paths live on the same upload volume.
      await fs.link(staged, original);
      await fs.unlink(staged);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (code === 'EEXIST') {
        await fs.unlink(staged).catch(() => undefined);
        return;
      }
      throw error;
    }
  }

  /** Permanently remove a staged file after its DB row deletion commits. */
  async finalizeStagedDelete(stagedKey: string): Promise<void> {
    this.assertDeletionQueueKey(stagedKey);
    await fs.unlink(this.resolveWithinUploadDir(stagedKey)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  async listStagedDeletes(limit = Number.POSITIVE_INFINITY): Promise<StagedAttachmentDeletion[]> {
    const directory = join(this.config.TELECOM_HD_UPLOAD_DIR, '.deletion-queue');
    const handle = await fs.opendir(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return [];
    const staged: StagedAttachmentDeletion[] = [];
    let examined = 0;
    for await (const entry of handle) {
      if (examined >= limit) break;
      examined += 1;
      if (!entry.isFile()) continue;
      const match = /^(\d+)-[0-9a-f-]+\.pending$/i.exec(entry.name);
      if (!match?.[1]) continue;
      staged.push({
        attachmentId: Number(match[1]),
        storageKey: join('.deletion-queue', entry.name),
      });
    }
    return staged;
  }

  /** Remove abandoned Multer quarantine files older than the configured TTL. */
  async cleanupStaleQuarantine(
    cutoff: Date,
    limit = Number.POSITIVE_INFINITY,
    deadline = Number.POSITIVE_INFINITY,
  ): Promise<{ files: number; bytes: number }> {
    const directory = join(this.config.TELECOM_HD_UPLOAD_DIR, 'quarantine');
    const handle = await fs.opendir(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!handle) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    let examined = 0;
    for await (const entry of handle) {
      if (examined >= limit || Date.now() >= deadline) break;
      examined += 1;
      if (!entry.isFile()) continue;
      const path = join(directory, entry.name);
      const stat = await fs.stat(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.mtime >= cutoff) continue;
      await fs.unlink(path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      files += 1;
      bytes += stat.size;
    }
    return { files, bytes };
  }

  private assertDeletionQueueKey(storageKey: string): void {
    if (!/^\.deletion-queue[\\/]\d+-[0-9a-f-]+\.pending$/i.test(storageKey)) {
      throw new BadRequestException('Invalid staged deletion key');
    }
  }
}
