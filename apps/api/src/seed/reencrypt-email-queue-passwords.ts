/**
 * Convert legacy plaintext EmailQueue.passwordEnc values to AES-256-GCM.
 *
 * This is deliberately a deployment gate, not a background worker. It runs only
 * after the old API and BullMQ workers have stopped, before the new production
 * runtime starts requiring TELECOM_HD_FIELD_ENCRYPTION_KEY. Every update uses a
 * compare-and-swap predicate so a direct database edit cannot be overwritten.
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
  legacyEncrypted: number;
  existingCiphertextsValidated: number;
  deletedDuringCas: number;
  casRetries: number;
  clean: boolean;
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
 * ciphertext with the configured key. The operation is idempotent: rerunning it
 * only validates already-encrypted rows.
 */
export async function reencryptEmailQueuePasswords(
  db: EmailQueuePasswordStore,
  fieldEncryptionKey: string | undefined,
): Promise<EmailQueuePasswordEncryptionReport> {
  assertFieldEncryptionKey(fieldEncryptionKey);

  const report: EmailQueuePasswordEncryptionReport = {
    scanned: 0,
    empty: 0,
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
  if (remainingLegacy > 0) {
    throw new Error(`Field-encryption migration left ${remainingLegacy} legacy queue credential row(s)`);
  }

  report.clean = true;
  return report;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const report = await reencryptEmailQueuePasswords(prisma, config.TELECOM_HD_FIELD_ENCRYPTION_KEY);
  console.log('=== EmailQueue field-encryption migration (aggregate only) ===');
  console.log(JSON.stringify(report, null, 2));
  console.log('CLEAN — every current non-empty queue credential is validated v1 ciphertext.');
}

if (require.main === module) {
  main()
    .catch(() => {
      console.error('EmailQueue field-encryption migration failed; no queue data was printed.');
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
