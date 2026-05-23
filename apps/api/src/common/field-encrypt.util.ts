/**
 * AES-256-GCM field-level encryption utility.
 *
 * Format (encrypted):  v1:<ivHex>:<authTagHex>:<ciphertextHex>
 * Legacy (plaintext):  any string NOT starting with "v1:" — returned as-is
 *                      (rolling migration: old rows work transparently until re-encrypted).
 *
 * The 256-bit key must be supplied as a 64-character hex string via
 * TELECOM_HD_FIELD_ENCRYPTION_KEY.  When the env var is absent the utility
 * returns the plaintext unchanged (development convenience + test safety).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV — GCM standard
const TAG_BYTES = 16;
const V1_PREFIX = 'v1:';

const logger = new Logger('FieldEncrypt');

function resolveKey(hexKey: string | undefined): Buffer | null {
  if (!hexKey) return null;
  if (hexKey.length !== 64) {
    logger.warn('TELECOM_HD_FIELD_ENCRYPTION_KEY must be 64 hex chars (256 bits) — encryption disabled');
    return null;
  }
  return Buffer.from(hexKey, 'hex');
}

/**
 * Encrypt a plaintext field value.
 * Returns the value unchanged when no key is configured or value is already encrypted.
 */
export function encryptField(value: string, hexKey?: string): string {
  if (value.startsWith(V1_PREFIX)) return value; // already encrypted — idempotent
  const key = resolveKey(hexKey ?? process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY']);
  if (!key) return value; // no key → passthrough

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${V1_PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

/**
 * Decrypt a field value that was encrypted with encryptField.
 * Throws if the ciphertext is corrupt or the key is wrong.
 * Returns the value unchanged for legacy (non-v1:) strings.
 */
export function decryptField(value: string, hexKey?: string): string {
  if (!value.startsWith(V1_PREFIX)) return value; // legacy passthrough

  const key = resolveKey(hexKey ?? process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY']);
  if (!key) {
    throw new Error('Cannot decrypt field: TELECOM_HD_FIELD_ENCRYPTION_KEY is not configured');
  }

  const rest = value.slice(V1_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted field: expected v1:<iv>:<tag>:<ct>');
  }
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];

  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');

  if (iv.length !== IV_BYTES) throw new Error('Invalid IV length in encrypted field');
  if (tag.length !== TAG_BYTES) throw new Error('Invalid auth tag length in encrypted field');

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
