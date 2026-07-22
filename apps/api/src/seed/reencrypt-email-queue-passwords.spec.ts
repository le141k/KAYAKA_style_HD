import { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { decryptField, encryptField } from '../common/field-encrypt.util';
import {
  reencryptEmailQueuePasswords,
  type EmailQueuePasswordEncryptionReport,
} from './reencrypt-email-queue-passwords';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);

type QueuePasswordRow = { id: number; passwordEnc: string };

function fakeStore(initialRows: QueuePasswordRow[]) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));
  const emailQueue = {
    findMany: vi.fn(async () => [...rows.values()].map((row) => ({ ...row }))),
    findUnique: vi.fn(async ({ where }: { where: { id: number } }) => {
      const row = rows.get(where.id);
      return row ? { ...row } : null;
    }),
    updateMany: vi.fn(
      async ({
        where,
        data,
      }: {
        where: { id: number; passwordEnc: string };
        data: { passwordEnc: string };
      }) => {
        const row = rows.get(where.id);
        if (!row || row.passwordEnc !== where.passwordEnc) return { count: 0 };
        row.passwordEnc = data.passwordEnc;
        return { count: 1 };
      },
    ),
  };

  return {
    db: { emailQueue } as unknown as Pick<PrismaClient, 'emailQueue'>,
    rows,
    emailQueue,
  };
}

describe('reencryptEmailQueuePasswords', () => {
  it('CAS-encrypts legacy non-empty values and leaves empty values untouched', async () => {
    const { db, rows, emailQueue } = fakeStore([
      { id: 1, passwordEnc: 'legacy-password' },
      { id: 2, passwordEnc: '' },
    ]);

    const report = await reencryptEmailQueuePasswords(db, KEY);

    expect(report).toMatchObject<Partial<EmailQueuePasswordEncryptionReport>>({
      scanned: 2,
      empty: 1,
      legacyEncrypted: 1,
      existingCiphertextsValidated: 0,
      clean: true,
    });
    expect(decryptField(rows.get(1)?.passwordEnc ?? '', KEY)).toBe('legacy-password');
    expect(rows.get(2)?.passwordEnc).toBe('');
    expect(emailQueue.updateMany).toHaveBeenCalledWith({
      where: { id: 1, passwordEnc: 'legacy-password' },
      data: { passwordEnc: expect.stringMatching(/^v1:/) },
    });
  });

  it('is idempotent and validates existing ciphertext with the configured key', async () => {
    const encrypted = encryptField('already-encrypted', KEY);
    const { db, emailQueue } = fakeStore([{ id: 1, passwordEnc: encrypted }]);

    const report = await reencryptEmailQueuePasswords(db, KEY);

    expect(report).toMatchObject({
      legacyEncrypted: 0,
      existingCiphertextsValidated: 1,
      clean: true,
    });
    expect(emailQueue.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed if an existing ciphertext cannot be decrypted with the configured key', async () => {
    const { db, emailQueue } = fakeStore([{ id: 1, passwordEnc: encryptField('secret', OTHER_KEY) }]);

    await expect(reencryptEmailQueuePasswords(db, KEY)).rejects.toThrow();
    expect(emailQueue.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed key before reading queue credentials', async () => {
    const { db, emailQueue } = fakeStore([{ id: 1, passwordEnc: 'legacy-password' }]);

    await expect(reencryptEmailQueuePasswords(db, undefined)).rejects.toThrow(/64-character hexadecimal/i);
    await expect(reencryptEmailQueuePasswords(db, 'not-a-key')).rejects.toThrow(/64-character hexadecimal/i);
    expect(emailQueue.findMany).not.toHaveBeenCalled();
  });

  it('retries against the current value after a CAS conflict instead of overwriting it', async () => {
    const { db, rows, emailQueue } = fakeStore([{ id: 1, passwordEnc: 'old-password' }]);
    emailQueue.updateMany.mockImplementationOnce(
      async ({ where }: { where: { id: number; passwordEnc: string } }) => {
        const row = rows.get(where.id);
        if (row) row.passwordEnc = 'rotated-password';
        return { count: 0 };
      },
    );

    const report = await reencryptEmailQueuePasswords(db, KEY);

    expect(report).toMatchObject({ casRetries: 1, legacyEncrypted: 1, clean: true });
    expect(decryptField(rows.get(1)?.passwordEnc ?? '', KEY)).toBe('rotated-password');
    expect(emailQueue.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: { id: 1, passwordEnc: 'old-password' } }),
    );
    expect(emailQueue.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: { id: 1, passwordEnc: 'rotated-password' } }),
    );
  });

  it('fails if the final verification still observes a legacy plaintext value', async () => {
    const { db, emailQueue } = fakeStore([{ id: 1, passwordEnc: 'legacy-password' }]);
    emailQueue.findMany
      .mockResolvedValueOnce([{ id: 1, passwordEnc: 'legacy-password' }])
      .mockResolvedValueOnce([{ id: 1, passwordEnc: 'concurrent-plaintext' }]);

    await expect(reencryptEmailQueuePasswords(db, KEY)).rejects.toThrow(/left 1 legacy/i);
  });
});
