import { describe, it, expect } from 'vitest';
import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { ClientPortalGuard } from './client-portal.guard';
import type { AppConfig } from '../config/configuration';

const CTX = {} as ExecutionContext;

function guard(over: Partial<AppConfig>): ClientPortalGuard {
  return new ClientPortalGuard(over as AppConfig);
}

describe('ClientPortalGuard (S2-1 fail-closed gate)', () => {
  it('allows the client portal routes in development', () => {
    expect(guard({ NODE_ENV: 'development', TELECOM_HD_CLIENT_PORTAL_ENABLED: false }).canActivate(CTX)).toBe(
      true,
    );
  });

  it('allows the client portal routes in test', () => {
    expect(guard({ NODE_ENV: 'test', TELECOM_HD_CLIENT_PORTAL_ENABLED: false }).canActivate(CTX)).toBe(true);
  });

  it('fails closed with 404 in production by default', () => {
    expect(() =>
      guard({ NODE_ENV: 'production', TELECOM_HD_CLIENT_PORTAL_ENABLED: false }).canActivate(CTX),
    ).toThrow(NotFoundException);
  });

  it('allows the routes in production only when explicitly enabled', () => {
    expect(guard({ NODE_ENV: 'production', TELECOM_HD_CLIENT_PORTAL_ENABLED: true }).canActivate(CTX)).toBe(
      true,
    );
  });
});
