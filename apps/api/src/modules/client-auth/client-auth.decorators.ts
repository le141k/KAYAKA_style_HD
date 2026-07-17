import { applyDecorators, createParamDecorator, ExecutionContext, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../auth/auth.decorators';
import { ClientPortalGuard } from '../../auth/client-portal.guard';
import { ClientAuthGuard } from './client-auth.guard';
import type { ClientPrincipal } from './client-auth.service';

/** Name of the HttpOnly client-session cookie. */
export const CLIENT_SESSION_COOKIE = 'th_client';

/**
 * Marks a route as authenticated by a verified CLIENT session (not staff JWT).
 * Composes `@Public()` (so the global staff JWT guard steps aside) with the
 * `ClientPortalGuard` (S2-1 fail-closed: the WHOLE client surface returns 404 in
 * production until the portal is explicitly enabled) and the `ClientAuthGuard`
 * (which enforces the session) as ONE decorator — you cannot apply `@Public()` here
 * and forget the guards, which would expose the route (S2-6).
 */
export function ClientAuthenticated(): ReturnType<typeof applyDecorators> {
  return applyDecorators(Public(), UseGuards(ClientPortalGuard, ClientAuthGuard));
}

/** Inject the resolved client principal ({ userId }) into a handler param. */
export const CurrentClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientPrincipal => {
    const request = ctx.switchToHttp().getRequest<Request & { client?: ClientPrincipal }>();
    return request.client as ClientPrincipal;
  },
);
