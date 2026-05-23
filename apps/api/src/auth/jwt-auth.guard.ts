import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY, AuthStaff } from './auth.decorators';
import { AppConfig, APP_CONFIG } from '../config/configuration';
import type { Request } from 'express';

/**
 * Global JWT guard.
 * - Routes decorated with @Public() bypass token validation entirely.
 * - All other routes require a valid Bearer access token in Authorization header.
 * - On success, sets req.user to an AuthStaff principal.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearer(request);

    if (!token) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    try {
      const payload = await this.jwtService.verifyAsync<AuthStaff & { sub: number }>(token, {
        secret: this.config.TELECOM_HD_JWT_ACCESS_SECRET,
      });

      // Normalise: staffId is stored in `sub` by AuthService
      const staff: AuthStaff = {
        staffId: payload.staffId ?? payload.sub,
        email: payload.email,
        isAdmin: payload.isAdmin,
        permissions: payload.permissions,
        // Carry the display-name claims through so /auth/me exposes them.
        firstName: payload.firstName,
        lastName: payload.lastName,
        fullName: payload.fullName,
      };
      (request as Request & { user: AuthStaff }).user = staff;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }

    return true;
  }

  private extractBearer(request: Request): string | undefined {
    const auth = request.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return undefined;
    return auth.slice(7);
  }
}
