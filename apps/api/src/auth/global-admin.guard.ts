import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthStaff } from './auth.decorators';

/**
 * Global configuration cannot be meaningfully filtered by department. A custom
 * non-admin capability grant therefore must never substitute for isAdmin here.
 */
@Injectable()
export class GlobalAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: AuthStaff }>();
    if (!request.user?.isAdmin) throw new ForbiddenException('Global administrator access required');
    return true;
  }
}
