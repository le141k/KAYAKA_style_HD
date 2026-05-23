/**
 * One-off migration script: encrypt existing plaintext IMAP passwords in EmailQueue.
 * Idempotent — rows already in v1: format are skipped.
 *
 * Usage:
 *   TELECOM_HD_FIELD_ENCRYPTION_KEY=<64 hex chars> tsx scripts/encrypt-queues.ts
 */

import { PrismaClient } from '@prisma/client';
import { encryptField } from '../src/common/field-encrypt.util';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
  if (!encKey) {
    console.error('TELECOM_HD_FIELD_ENCRYPTION_KEY is not set — aborting');
    process.exit(1);
  }

  const queues = await prisma.emailQueue.findMany({ select: { id: true, passwordEnc: true } });
  let updated = 0;
  let skipped = 0;

  for (const queue of queues) {
    if (queue.passwordEnc.startsWith('v1:')) {
      skipped++;
      continue;
    }
    const encrypted = encryptField(queue.passwordEnc, encKey);
    await prisma.emailQueue.update({ where: { id: queue.id }, data: { passwordEnc: encrypted } });
    updated++;
  }

  console.log(`Done. Updated: ${updated}, Skipped (already encrypted): ${skipped}`);
}

main()
  .catch((err: unknown) => {
    console.error('encrypt-queues error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
