import { describe, expect, it } from 'vitest';
import { cutoverStateIsClean } from './audit-redis-cutover';

describe('Redis cutover state gate', () => {
  it('requires all queues paused and no active jobs for a pause gate', () => {
    expect(
      cutoverStateIsClean({ pauseRequested: true, resumeRequested: false, active: 0, allPaused: true }),
    ).toBe(true);
    expect(
      cutoverStateIsClean({ pauseRequested: true, resumeRequested: false, active: 0, allPaused: false }),
    ).toBe(false);
    expect(
      cutoverStateIsClean({ pauseRequested: true, resumeRequested: false, active: 1, allPaused: true }),
    ).toBe(false);
  });

  it('requires every queue to be resumed for a resume gate', () => {
    expect(
      cutoverStateIsClean({ pauseRequested: false, resumeRequested: true, active: 0, allPaused: false }),
    ).toBe(true);
    expect(
      cutoverStateIsClean({ pauseRequested: false, resumeRequested: true, active: 0, allPaused: true }),
    ).toBe(false);
  });
});
