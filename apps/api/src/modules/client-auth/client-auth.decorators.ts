import { applyDecorators, createParamDecorator, ExecutionContext, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../auth/auth.decorators';
import { ClientAuthGuard } from './client-auth.guard';
import type { ClientPrincipal } from './client-auth.service';

/** Name of the HttpOnly client-session cookie. */
export const CLIENT_SESSION_COOKIE = 'th_client';

/**
 * Marks a route as authenticated by a verified CLIENT session (not staff JWT).
 * Composes `@Public()` (so the global staff JWT guard steps aside) with the
 * `ClientAuthGuard` (which enforces the session) as ONE decorator — you cannot apply
 * `@Public()` here and forget the guard, which would expose the route (S2-6).
 */
export function ClientAuthenticated(): ReturnType<typeof applyDecorators> {
  return applyDecorators(Public(), UseGuards(ClientAuthGuard));
}

/** Inject the resolved client principal ({ userId }) into a handler param. */
export const CurrentClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientPrincipal => {
    const request = ctx.switchToHttp().getRequest<Request & { client?: ClientPrincipal }>();
    return request.client as ClientPrincipal;
  },
);
