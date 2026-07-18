/** Operational ClamAV probe: verifies fresh signatures and a clean streamed scan. */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/configuration';
import { ClamAvService } from '../security/clamav.service';

async function main(): Promise<void> {
  const config = loadConfig();
  const directory = join(config.TELECOM_HD_UPLOAD_DIR, 'quarantine');
  const path = join(directory, `scanner-readiness-${randomUUID()}.txt`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path, '23 Telecom scanner readiness probe\n', { mode: 0o600 });
    await new ClamAvService(config).scanFile(path);
    console.log('CLEAN — scanner reachable, signatures fresh and streaming scan passed.');
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

void main().catch(() => {
  console.error('NOT CLEAN — scanner readiness probe failed; no file data was printed.');
  process.exitCode = 1;
});
