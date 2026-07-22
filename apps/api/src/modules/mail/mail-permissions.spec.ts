import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS } from '../../auth/permissions';
import { PermissionsGuard, PERMISSIONS_KEY } from '../../auth/permissions.guard';
import { EmailQueueController } from './email-queue.controller';

describe('mail controller permissions', () => {
  it('splits view/replay/reconcile/configure at the backend route boundary', () => {
    const proto = EmailQueueController.prototype;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.list)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.listQuarantined)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.replayQuarantined)).toEqual([PERMISSIONS.MAIL_REPLAY]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.reconcile)).toEqual([PERMISSIONS.MAIL_RECONCILE]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.create)).toEqual([PERMISSIONS.MAIL_CONFIGURE]);
  });

  it('returns 403 for a view-only operator attempting replay, and 200-path for the matching permission', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue([PERMISSIONS.MAIL_REPLAY]),
    };
    const guard = new PermissionsGuard(reflector as never);
    const contextFor = (permissions: string[]) =>
      ({
        getHandler: () => undefined,
        getClass: () => undefined,
        switchToHttp: () => ({
          getRequest: () => ({ user: { isAdmin: false, permissions } }),
        }),
      }) as never;

    expect(() => guard.canActivate(contextFor([PERMISSIONS.MAIL_VIEW]))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor([PERMISSIONS.MAIL_REPLAY]))).toBe(true);
  });
});
