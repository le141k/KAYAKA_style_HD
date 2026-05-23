import { describe, it, expect } from 'vitest';
import { encryptField, decryptField } from './field-encrypt.util';

// Generate a fixed 32-byte key as 64 hex chars for testing
const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const WRONG_KEY = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

describe('field-encrypt.util', () => {
  // ─── roundtrip ──────────────────────────────────────────────────────────────

  describe('roundtrip', () => {
    it('encrypts and decrypts a simple string correctly', () => {
      const plaintext = 'my-secret-password';
      const encrypted = encryptField(plaintext, TEST_KEY);
      expect(encrypted).toMatch(/^v1:/);
      const decrypted = decryptField(encrypted, TEST_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('roundtrips an empty string', () => {
      const encrypted = encryptField('', TEST_KEY);
      expect(encrypted).toMatch(/^v1:/);
      expect(decryptField(encrypted, TEST_KEY)).toBe('');
    });

    it('roundtrips a unicode string', () => {
      const plaintext = 'пароль123!';
      const encrypted = encryptField(plaintext, TEST_KEY);
      expect(decryptField(encrypted, TEST_KEY)).toBe(plaintext);
    });

    it('produces different ciphertexts for the same plaintext (random IV)', () => {
      const p = 'same-password';
      const e1 = encryptField(p, TEST_KEY);
      const e2 = encryptField(p, TEST_KEY);
      expect(e1).not.toBe(e2); // random IV ensures ciphertext differs
    });
  });

  // ─── idempotent ─────────────────────────────────────────────────────────────

  describe('idempotent', () => {
    it('encryptField does not double-encrypt an already-encrypted value', () => {
      const encrypted = encryptField('password', TEST_KEY);
      const doubleEncrypted = encryptField(encrypted, TEST_KEY);
      expect(doubleEncrypted).toBe(encrypted);
    });
  });

  // ─── legacy passthrough ─────────────────────────────────────────────────────

  describe('legacy passthrough', () => {
    it('decryptField returns non-v1: strings unchanged', () => {
      const plain = 'legacy-plain-password';
      expect(decryptField(plain, TEST_KEY)).toBe(plain);
    });

    it('decryptField returns empty string unchanged', () => {
      expect(decryptField('', TEST_KEY)).toBe('');
    });

    it('encryptField returns value unchanged when no key is provided', () => {
      // Override env to undefined
      const orig = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      delete process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      const result = encryptField('no-key-password');
      expect(result).toBe('no-key-password');
      // restore
      if (orig !== undefined) process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'] = orig;
    });
  });

  // ─── wrong key (tamper) ──────────────────────────────────────────────────────

  describe('wrong key / tamper', () => {
    it('throws when decrypting with a different key', () => {
      const encrypted = encryptField('secret', TEST_KEY);
      expect(() => decryptField(encrypted, WRONG_KEY)).toThrow();
    });

    it('throws when ciphertext is truncated', () => {
      const encrypted = encryptField('secret', TEST_KEY);
      const truncated = encrypted.slice(0, encrypted.length - 4);
      expect(() => decryptField(truncated, TEST_KEY)).toThrow();
    });
  });

  // ─── no-key decrypt ──────────────────────────────────────────────────────────

  describe('no-key behavior', () => {
    it('decryptField throws when key is missing and value starts with v1:', () => {
      const encrypted = encryptField('password', TEST_KEY);
      // call with explicit undefined key (not in env)
      const orig = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      delete process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      expect(() => decryptField(encrypted, undefined)).toThrow(/not configured/i);
      if (orig !== undefined) process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'] = orig;
    });
  });
});
