import { Injectable, Inject, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { join } from 'node:path';
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

  /** Open a read stream for an existing storageKey. */
  createReadStream(storageKey: string): ReadStream {
    const fullPath = join(this.config.TELECOM_HD_UPLOAD_DIR, storageKey);
    return createReadStream(fullPath);
  }

  /** Delete a file by storageKey. Silently ignores missing files. */
  async delete(storageKey: string): Promise<void> {
    const fullPath = join(this.config.TELECOM_HD_UPLOAD_DIR, storageKey);
    try {
      await fs.unlink(fullPath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}
