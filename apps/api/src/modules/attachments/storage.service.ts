import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { APP_CONFIG, AppConfig } from '../../config/configuration';

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
    this.logger.debug(`Stored file: ${keyRelative} (sha1=${sha1})`);

    return { storageKey: keyRelative, sha1 };
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
}
