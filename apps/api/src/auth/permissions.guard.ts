import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Permission } from './permissions';
import type { AuthStaff } from './auth.decorators';
import type { Request } from 'express';

/** Metadata key used by @RequirePermissions. */
export const PERMISSIONS_KEY = 'permissions';

/**
 * Guard that enforces required permissions on a route.
 * Must run AFTER JwtAuthGuard has populated req.user.
 * Admin staff (isAdmin = true) pass all permission checks unconditionally.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No permissions required → allow through
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: AuthStaff }>();
    const staff = request.user;

    if (!staff) {
      throw new ForbiddenException('Not authenticated');
    }

    // Admin members inherit all permissions
    if (staff.isAdmin) return true;

    const hasAll = required.every((perm) => staff.permissions.includes(perm));
    if (!hasAll) {
      throw new ForbiddenException('Insufficient permissions');
    }

    return true;
  }
}
