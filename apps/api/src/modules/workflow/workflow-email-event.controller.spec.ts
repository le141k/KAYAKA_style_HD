import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PERMISSIONS } from '../../auth/permissions';
import { PermissionsGuard, PERMISSIONS_KEY } from '../../auth/permissions.guard';
import { WorkflowEmailEventController } from './workflow.controller';

describe('workflow email event operator permissions', () => {
  it('keeps observation and explicit replay behind the mail view plus replay capability split', () => {
    const proto = WorkflowEmailEventController.prototype;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.health)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.list)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.get)).toEqual([PERMISSIONS.MAIL_VIEW]);
    expect(Reflect.getMetadata(PERMISSIONS_KEY, proto.replay)).toEqual([
      PERMISSIONS.MAIL_VIEW,
      PERMISSIONS.MAIL_REPLAY,
    ]);
  });

  it('returns 403 for view-only and action-only workflow-email replay roles', () => {
    const reflector = {
      getAllAndOverride: vi.fn().mockReturnValue([PERMISSIONS.MAIL_VIEW, PERMISSIONS.MAIL_REPLAY]),
    };
    const guard = new PermissionsGuard(reflector as never);
    const context = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({ user: { isAdmin: false, permissions: [PERMISSIONS.MAIL_VIEW] } }),
      }),
    };

    expect(() => guard.canActivate(context as never)).toThrow(ForbiddenException);
    const actionOnlyContext = {
      ...context,
      switchToHttp: () => ({
        getRequest: () => ({ user: { isAdmin: false, permissions: [PERMISSIONS.MAIL_REPLAY] } }),
      }),
    } as never;
    expect(() => guard.canActivate(actionOnlyContext as never)).toThrow(ForbiddenException);
  });
});
