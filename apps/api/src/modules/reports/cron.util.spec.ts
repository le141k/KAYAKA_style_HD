import { describe, it, expect } from 'vitest';
import { nextRunFromCron, isValidCron } from './cron.util';

describe('nextRunFromCron', () => {
  it('computes the next fire strictly after `from`', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const next = nextRunFromCron('*/5 * * * *', from);
    expect(next.toISOString()).toBe('2026-01-01T00:05:00.000Z');
  });

  it('handles a daily cron', () => {
    const from = new Date('2026-01-01T10:00:00Z');
    const next = nextRunFromCron('0 0 * * *', from);
    expect(next.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('throws on an invalid expression', () => {
    expect(() => nextRunFromCron('not-a-cron', new Date())).toThrow();
  });
});

describe('isValidCron', () => {
  it('accepts valid expressions', () => {
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
  });
  it('rejects garbage', () => {
    expect(isValidCron('nope')).toBe(false);
    expect(isValidCron('99 99 99 99 99')).toBe(false);
  });
});
