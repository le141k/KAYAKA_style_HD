import * as argon2 from 'argon2';

/**
 * E2: pin argon2id cost parameters explicitly rather than relying on the library
 * defaults (which can shift between versions). These meet the OWASP 2024 minimum
 * (≥19 MiB memory, ≥2 iterations). The encoded hash records its own params, so
 * existing hashes still verify if we raise these later.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Hash a plain-text password using argon2id.
 * Returns the encoded hash string suitable for storage.
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, ARGON2_OPTIONS);
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
