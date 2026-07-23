import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS } from '../../auth/permissions';
import { PermissionsGuard, PERMISSIONS_KEY } from '../../auth/permissions.guard';
import { EmailQueueController } from './email-queue.controller';
import { OutboundEmailController } from './outbound-email.controller';

describe('mail controller permissions', () => {
  it('requires mail visibility plus the matching operator capability at every mail mutation boundary', () => {
    const proto = EmailQueueController.prototype;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.list)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.listQuarantined)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.replayQuarantined)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_REPLAY,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.listCaptured)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.getCaptured)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.promoteCaptured)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_PROMOTE_CAPTURED,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.reconcile)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_RECONCILE,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.create)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_CONFIGURE,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.update)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_CONFIGURE,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.delete)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_CONFIGURE,
    ]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, OutboundEmailController.prototype.retry)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_CONFIGURE,
    ]);
  });

  it('refuses both action-only and view-only quarantine replay roles', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue([PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_REPLAY]),
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
    expect(() => guard.canActivate(contextFor([PERMISSIONS.MAIL_REPLAY]))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor([PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_REPLAY]))).toBe(true);
  });

  it('requires both review visibility and the separate promotion permission for an inert capture', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue([PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_PROMOTE_CAPTURED]),
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

    expect(() => guard.canActivate(contextFor([PERMISSIONS.MAIL_REPLAY]))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor([PERMISSIONS.MAIL_PROMOTE_CAPTURED]))).toThrow(
      ForbiddenException,
    );
    expect(() => guard.canActivate(contextFor([PERMISSIONS.MAIL_VIEW]))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor([PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_PROMOTE_CAPTURED]))).toBe(
      true,
    );
  });
});
