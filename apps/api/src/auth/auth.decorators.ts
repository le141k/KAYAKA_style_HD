import {
  applyDecorators,
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard, PERMISSIONS_KEY } from './permissions.guard';
import type { Permission } from './permissions';

export interface AuthStaff {
  staffId: number;
  email: string;
  isAdmin: boolean;
  permissions: Permission[];
  firstName?: string;
  lastName?: string;
  fullName?: string;
  /** Access-token id + expiry (epoch s) — carried through for logout revocation. */
  jti?: string;
  exp?: number;
}

/** Marks a route as public (skips JwtAuthGuard). */
export const IS_PUBLIC_KEY = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires the authenticated staff to hold every listed permission. */
export function RequirePermissions(...perms: Permission[]) {
  return applyDecorators(
    SetMetadata(PERMISSIONS_KEY, perms),
    UseGuards(JwtAuthGuard, PermissionsGuard),
    ApiBearerAuth(),
  );
}

/** Injects the authenticated staff principal into a handler param. */
export const CurrentStaff = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthStaff => {
  const req = ctx.switchToHttp().getRequest();
  return req.user as AuthStaff;
});
