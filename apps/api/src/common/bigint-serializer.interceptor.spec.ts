import { describe, it, expect } from 'vitest';
import { serializeBigInt } from './bigint-serializer.interceptor';

describe('serializeBigInt', () => {
  it('converts a bare BigInt to a decimal string', () => {
    expect(serializeBigInt(42n)).toBe('42');
    // Beyond Number.MAX_SAFE_INTEGER — must stay exact as a string.
    expect(serializeBigInt(9007199254740993n)).toBe('9007199254740993');
  });

  it('converts BigInt fields nested in objects and arrays', () => {
    const out = serializeBigInt({
      id: 1,
      lastSeenUid: 5_000_000_000n,
      uidValidity: null,
      nested: [{ uid: 7n }, { uid: 8n }],
    });
    expect(out).toEqual({
      id: 1,
      lastSeenUid: '5000000000',
      uidValidity: null,
      nested: [{ uid: '7' }, { uid: '8' }],
    });
  });

  it('leaves Date and non-BigInt primitives untouched', () => {
    const date = new Date('2026-07-18T00:00:00.000Z');
    const out = serializeBigInt({ when: date, n: 3, s: 'x', b: true }) as Record<string, unknown>;
    expect(out.when).toBe(date);
    expect(out).toMatchObject({ n: 3, s: 'x', b: true });
  });

  it('returns the SAME reference when there is no BigInt (no needless rebuild)', () => {
    const input = { a: 1, b: { c: 'x' } };
    expect(serializeBigInt(input)).toBe(input);
  });
});
