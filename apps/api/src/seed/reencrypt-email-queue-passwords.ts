/**
 * Convert legacy plaintext EmailQueue.passwordEnc values to AES-256-GCM.
 *
 * This is deliberately a deployment gate, not a background worker. Its
 * `--verify-only` mode runs while the old release is still online and only
 * proves that every existing v1 ciphertext authenticates with the proposed key.
 * Conversion runs only after the deployment has crossed its verified,
 * forward-only schema boundary. Every update uses a compare-and-swap predicate
 * so a direct database edit cannot be overwritten.
 *
 * Output is aggregate-only: queue ids, addresses, passwords and ciphertext are
 * never printed.
 */
import { PrismaClient } from '@prisma/client';
import { decryptField, encryptField } from '../common/field-encrypt.util';
import { loadConfig } from '../config/configuration';

const prisma = new PrismaClient();
const FIELD_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_CAS_RETRIES = 3;

type QueuePasswordRow = { id: number; passwordEnc: string };

/** Aggregate-only evidence suitable for deployment logs. */
export interface EmailQueuePasswordEncryptionReport {
  scanned: number;
  empty: number;
  /** Plaintext rows observed in read-only verification; expected before first conversion. */
  legacyPlaintextObserved: number;
  legacyEncrypted: number;
  existingCiphertextsValidated: number;
  deletedDuringCas: number;
  casRetries: number;
  clean: boolean;
}

export interface ReencryptEmailQueuePasswordOptions {
  /** Validate current ciphertexts without writing or rejecting legacy plaintext. */
  verifyOnly?: boolean;
}

type EmailQueuePasswordStore = Pick<PrismaClient, 'emailQueue'>;

function isCiphertext(value: string): boolean {
  return value.startsWith('v1:');
}

function assertFieldEncryptionKey(key: string | undefined): asserts key is string {
  if (!key || !FIELD_KEY_PATTERN.test(key)) {
    throw new Error('Field-encryption migration requires a valid 64-character hexadecimal key');
  }
}

async function listQueuePasswords(db: EmailQueuePasswordStore): Promise<QueuePasswordRow[]> {
  return db.emailQueue.findMany({ select: { id: true, passwordEnc: true } });
}

/**
 * Re-encrypt all current legacy queue passwords and validate every current v1
 * ciphertext with the configured key. The default operation is idempotent:
 * rerunning it only validates already-encrypted rows. `verifyOnly` is strictly
 * read-only and deliberately permits plaintext rows so an old release can be
 * checked safely before the irreversible deployment boundary.
 */
export async function reencryptEmailQueuePasswords(
  db: EmailQueuePasswordStore,
  fieldEncryptionKey: string | undefined,
  options: ReencryptEmailQueuePasswordOptions = {},
): Promise<EmailQueuePasswordEncryptionReport> {
  assertFieldEncryptionKey(fieldEncryptionKey);

  const report: EmailQueuePasswordEncryptionReport = {
    scanned: 0,
    empty: 0,
    legacyPlaintextObserved: 0,
    legacyEncrypted: 0,
    existingCiphertextsValidated: 0,
    deletedDuringCas: 0,
    casRetries: 0,
    clean: false,
  };

  const rows = await listQueuePasswords(db);
  for (const initialRow of rows) {
    report.scanned += 1;
    let currentRow: QueuePasswordRow | null = initialRow;

    for (let attempt = 0; currentRow && attempt <= MAX_CAS_RETRIES; attempt += 1) {
      const currentValue = currentRow.passwordEnc;
      if (currentValue === '') {
        report.empty += 1;
        break;
      }

      if (isCiphertext(currentValue)) {
        // Never trust a v1 marker alone: this proves its auth tag and this exact
        // configured key work before the new API depends on it.
        decryptField(currentValue, fieldEncryptionKey);
        report.existingCiphertextsValidated += 1;
        break;
      }

      if (options.verifyOnly) {
        report.legacyPlaintextObserved += 1;
        break;
      }

      const encrypted = encryptField(currentValue, fieldEncryptionKey);
      if (!isCiphertext(encrypted)) {
        throw new Error('Field-encryption migration did not produce a ciphertext');
      }

      const updated = await db.emailQueue.updateMany({
        where: { id: currentRow.id, passwordEnc: currentValue },
        data: { passwordEnc: encrypted },
      });
      if (updated.count === 1) {
        report.legacyEncrypted += 1;
        break;
      }

      report.casRetries += 1;
      if (attempt === MAX_CAS_RETRIES) {
        throw new Error('Field-encryption migration could not stabilize a concurrent queue update');
      }

      currentRow = await db.emailQueue.findUnique({
        where: { id: initialRow.id },
        select: { id: true, passwordEnc: true },
      });
      if (!currentRow) {
        report.deletedDuringCas += 1;
      }
    }
  }

  // A final full scan closes the check-then-act window and protects a queue that
  // was altered directly while this one-shot gate ran. It validates ciphertexts
  // again without ever logging their contents.
  const finalRows = await listQueuePasswords(db);
  let remainingLegacy = 0;
  for (const row of finalRows) {
    if (row.passwordEnc === '') continue;
    if (!isCiphertext(row.passwordEnc)) {
      remainingLegacy += 1;
      continue;
    }
    decryptField(row.passwordEnc, fieldEncryptionKey);
  }
  if (options.verifyOnly) {
    // Prefer the final snapshot: it includes any direct update that occurred
    // during the first read-only pass while still never changing a row.
    report.legacyPlaintextObserved = remainingLegacy;
  } else if (remainingLegacy > 0) {
    throw new Error(`Field-encryption migration left ${remainingLegacy} legacy queue credential row(s)`);
  }

  report.clean = true;
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes('--verify-only');
  if (args.some((arg) => arg !== '--verify-only')) {
    throw new Error('Usage: reencrypt-email-queue-passwords [--verify-only]');
  }

  const config = loadConfig();
  const report = await reencryptEmailQueuePasswords(prisma, config.TELECOM_HD_FIELD_ENCRYPTION_KEY, {
    verifyOnly,
  });
  console.log(
    verifyOnly
      ? '=== EmailQueue field-encryption read-only verification (aggregate only) ==='
      : '=== EmailQueue field-encryption migration (aggregate only) ===',
  );
  console.log(JSON.stringify(report, null, 2));
  console.log(
    verifyOnly
      ? 'VERIFIED — every current v1 queue credential authenticates with this key; no row was changed.'
      : 'CLEAN — every current non-empty queue credential is validated v1 ciphertext.',
  );
}

if (require.main === module) {
  main()
    .catch(() => {
      console.error('EmailQueue field-encryption gate failed; no queue data was printed.');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
