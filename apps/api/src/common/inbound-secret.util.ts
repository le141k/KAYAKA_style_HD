import { timingSafeEqual } from 'node:crypto';

/**
 * Compare the inbound secret without an early content-dependent exit. The length
 * check is required because `timingSafeEqual` throws for differently-sized buffers.
 */
export function inboundSecretMatches(providedValue: string | undefined, expectedValue: string): boolean {
  const provided = Buffer.from(providedValue ?? '', 'utf8');
  const expected = Buffer.from(expectedValue, 'utf8');
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
}
