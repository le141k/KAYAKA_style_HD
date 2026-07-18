/**
 * DB/filesystem attachment reconciliation and malware scan.
 *
 * Default mode is read-only and exits non-zero on every mismatch. Pass
 * `--quarantine-unsafe` during a controlled maintenance window to move infected,
 * integrity-mismatched, and untracked bytes out of downloadable storage. Output is
 * aggregate-only and never includes filenames/storage keys (customer PII).
 */
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { loadConfig } from '../config/configuration';
import { ClamAvService } from '../security/clamav.service';
import { StorageService } from '../modules/attachments/storage.service';

const prisma = new PrismaClient();
const config = loadConfig();
const storage = new StorageService(config);
const scanner = new ClamAvService(config);
const quarantineUnsafe = process.argv.includes('--quarantine-unsafe');
const EXCLUDED_DIRS = new Set(['quarantine', 'reconciliation-quarantine', '.deletion-queue']);

interface ReconciliationReport {
  dbRows: number;
  scannedRows: number;
  missingFiles: number;
  invalidStorageKeys: number;
  duplicateStorageKeyRows: number;
  integrityMismatches: number;
  infectedFiles: number;
  scannerFailures: number;
  untrackedFiles: number;
  untrackedBytes: number;
  unsafeFilesystemEntries: number;
  staleTemporaryFiles: number;
  quarantinedFiles: number;
  clean: boolean;
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function moveToReconciliationQuarantine(path: string, label: string): Promise<void> {
  const directory = join(config.TELECOM_HD_UPLOAD_DIR, 'reconciliation-quarantine');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.rename(path, join(directory, `${label}-${randomUUID()}.quarantined`));
}

async function listPermanentEntries(root: string): Promise<{
  files: Map<string, number>;
  unsafe: number;
  staleTemporaryFiles: number;
}> {
  const files = new Map<string, number>();
  let unsafe = 0;
  let staleTemporaryFiles = 0;
  const tempCutoff = Date.now() - config.TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS * 60 * 60_000;

  async function walk(directory: string, topLevel = false): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (topLevel && EXCLUDED_DIRS.has(entry.name)) {
        if (entry.name === 'quarantine') {
          const temporary = await fs.readdir(path, { withFileTypes: true }).catch(() => []);
          for (const item of temporary) {
            if (!item.isFile()) {
              unsafe += 1;
              continue;
            }
            const stat = await fs.stat(join(path, item.name));
            if (stat.mtimeMs < tempCutoff) staleTemporaryFiles += 1;
          }
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const stat = await fs.stat(path);
        files.set(resolve(path), stat.size);
      } else {
        // Never follow symlinks/devices under the upload root.
        unsafe += 1;
      }
    }
  }

  await walk(root, true);
  return { files, unsafe, staleTemporaryFiles };
}

export async function auditAttachmentStorage(): Promise<ReconciliationReport> {
  const root = resolve(config.TELECOM_HD_UPLOAD_DIR);
  const rows = await prisma.attachment.findMany({
    select: { id: true, storageKey: true, size: true, sha1: true },
    orderBy: { id: 'asc' },
  });
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.storageKey, (counts.get(row.storageKey) ?? 0) + 1);

  const trackedPaths = new Set<string>();
  let scannedRows = 0;
  let missingFiles = 0;
  let invalidStorageKeys = 0;
  let integrityMismatches = 0;
  let infectedFiles = 0;
  let scannerFailures = 0;
  let quarantinedFiles = 0;
  let scannerOperational = config.TELECOM_HD_CLAMAV_ENABLED;
  if (!scannerOperational) scannerFailures = 1;

  for (const row of rows) {
    let path: string;
    try {
      path = storage.pathForKey(row.storageKey);
      const firstSegment = relative(root, path).split(/[\\/]/, 1)[0];
      if (firstSegment && EXCLUDED_DIRS.has(firstSegment)) throw new Error('quarantine storage key');
    } catch {
      invalidStorageKeys += 1;
      continue;
    }
    trackedPaths.add(path);

    let stat;
    try {
      stat = await fs.lstat(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missingFiles += 1;
        continue;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      invalidStorageKeys += 1;
      continue;
    }

    const hash = await digest(path);
    const integrityMismatch = stat.size !== row.size || !row.sha1 || hash !== row.sha1;
    if (integrityMismatch) integrityMismatches += 1;

    let infected = false;
    if (scannerOperational) {
      try {
        await scanner.scanFile(path);
        scannedRows += 1;
      } catch (error) {
        if (error instanceof BadRequestException) {
          infectedFiles += 1;
          infected = true;
        } else {
          scannerFailures += 1;
          scannerOperational = false;
        }
      }
    }

    if (quarantineUnsafe && (integrityMismatch || infected)) {
      await moveToReconciliationQuarantine(path, `db-${row.id}`);
      quarantinedFiles += 1;
    }
  }

  const filesystem = await listPermanentEntries(root);
  let untrackedFiles = 0;
  let untrackedBytes = 0;
  for (const [path, size] of filesystem.files) {
    if (trackedPaths.has(path)) continue;
    untrackedFiles += 1;
    untrackedBytes += size;
    if (quarantineUnsafe) {
      await moveToReconciliationQuarantine(path, `untracked-${basename(path).length}`);
      quarantinedFiles += 1;
    }
  }

  const duplicateStorageKeyRows = [...counts.values()].reduce(
    (total, count) => total + Math.max(0, count - 1),
    0,
  );
  const report = {
    dbRows: rows.length,
    scannedRows,
    missingFiles,
    invalidStorageKeys,
    duplicateStorageKeyRows,
    integrityMismatches,
    infectedFiles,
    scannerFailures,
    untrackedFiles,
    untrackedBytes,
    unsafeFilesystemEntries: filesystem.unsafe,
    staleTemporaryFiles: filesystem.staleTemporaryFiles,
    quarantinedFiles,
    clean: false,
  };
  report.clean =
    report.scannedRows === report.dbRows &&
    Object.entries(report).every(([key, value]) =>
      ['dbRows', 'scannedRows', 'untrackedBytes', 'quarantinedFiles', 'clean'].includes(key)
        ? true
        : value === 0,
    );
  return report;
}

if (require.main === module) {
  auditAttachmentStorage()
    .then((report) => {
      console.log('=== Attachment storage reconciliation (aggregate only) ===');
      console.log(JSON.stringify(report, null, 2));
      if (!report.clean) process.exitCode = 1;
    })
    .catch(() => {
      console.error('Attachment reconciliation failed; no row/file names were printed.');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
