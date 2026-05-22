import * as argon2 from 'argon2';

/**
 * Hash a plain-text password using argon2id.
 * Returns the encoded hash string suitable for storage.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

/**
 * Verify a plain-text password against a stored argon2 hash.
 * Returns true when the password matches.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
