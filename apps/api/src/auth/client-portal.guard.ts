import { CanActivate, ExecutionContext, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AppConfig, APP_CONFIG } from '../config/configuration';

/**
 * Fail-closed gate for the ENTIRE client portal surface (GOAL_PUBLIC_SECURITY S2-1).
 *
 * Applied (via `@ClientAuthenticated()` and the `ClientAuthController`) to every client
 * route: magic-link `request-link`/`verify`, the client ticket list/detail/reply, and the
 * owner-scoped attachment download — plus the still-unguarded public create/upload (S4).
 * None of these may be reachable in production until the verified client-session flow (S2)
 * and public-abuse controls (S4) are fully signed off for launch.
 *
 * In production the gate is CLOSED unless `TELECOM_HD_CLIENT_PORTAL_ENABLED` is set
 * (it stays off until S2/S4 land). Dev/test keep the routes so existing flows and
 * tests are unaffected. Returns 404 — not 403 — so the route's existence is not
 * advertised. The decision is server-side and does not depend on frontend behavior.
 */
@Injectable()
export class ClientPortalGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(_context: ExecutionContext): boolean {
    if (this.config.NODE_ENV === 'production' && !this.config.TELECOM_HD_CLIENT_PORTAL_ENABLED) {
      throw new NotFoundException();
    }
    return true;
  }
}
