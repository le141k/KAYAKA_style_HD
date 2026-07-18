import { describe, it, expect } from 'vitest';
import { normalizeEmail } from './email.util';

describe('normalizeEmail (S2-2)', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('is idempotent', () => {
    const once = normalizeEmail('  MixedCase@Host.Net  ');
    expect(normalizeEmail(once)).toBe(once);
  });

  it('collapses case/whitespace variants to one identity', () => {
    expect(normalizeEmail('BOB@x.io')).toBe(normalizeEmail(' bob@x.io '));
  });

  it('does NOT fold gmail dots/plus (distinct addresses stay distinct)', () => {
    expect(normalizeEmail('a.b+tag@gmail.com')).toBe('a.b+tag@gmail.com');
    expect(normalizeEmail('a.b+tag@gmail.com')).not.toBe(normalizeEmail('ab@gmail.com'));
  });

  it('trims exactly the ASCII whitespace set shared with PostgreSQL btrim', () => {
    expect(normalizeEmail('\v\f\r\n\t Alice@Example.COM \t')).toBe('alice@example.com');
    // NBSP is deliberately not part of the identity rule. Boundary validation rejects it,
    // and keeping it here avoids a JS/SQL normalization mismatch.
    expect(normalizeEmail('\u00a0Alice@Example.COM\u00a0')).toBe('\u00a0alice@example.com\u00a0');
  });
});
