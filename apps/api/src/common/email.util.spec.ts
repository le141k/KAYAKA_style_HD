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
});
