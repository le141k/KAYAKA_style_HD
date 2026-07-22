import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { GlobalAdminGuard } from './global-admin.guard';

function contextFor(user: unknown) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as never;
}

describe('GlobalAdminGuard', () => {
  const guard = new GlobalAdminGuard();

  it('allows only an actual administrator', () => {
    expect(guard.canActivate(contextFor({ staffId: 1, isAdmin: true }))).toBe(true);
  });

  it('does not treat an arbitrary mail capability as global administration', () => {
    expect(() =>
      guard.canActivate(contextFor({ staffId: 2, isAdmin: false, permissions: ['mail.configure'] })),
    ).toThrow(ForbiddenException);
  });
});
