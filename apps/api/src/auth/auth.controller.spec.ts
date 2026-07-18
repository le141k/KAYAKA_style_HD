import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import type { Response } from 'express';
import type { Request } from 'express';
import { AuthController } from './auth.controller';
import type { AuthService } from './auth.service';
import { CsrfService } from './csrf.service';
import type { Permission } from './permissions';
import type { AppConfig } from '../config/configuration';

const STAFF = {
  staffId: 1,
  email: 'staff@example.com',
  isAdmin: true,
  permissions: ['ticket.view'] as Permission[],
  firstName: 'Test',
  lastName: 'Staff',
  fullName: 'Test Staff',
};

function config(nodeEnv: 'test' | 'production' = 'test'): AppConfig {
  return {
    NODE_ENV: nodeEnv,
    TELECOM_HD_JWT_ACCESS_SECRET: 'controller-test-access-secret-32-characters',
    TELECOM_HD_JWT_ACCESS_TTL: 900,
    TELECOM_HD_JWT_REFRESH_TTL: 3600,
  } as AppConfig;
}

function response(cookieHeader = '') {
  const cookie = vi.fn();
  const clearCookie = vi.fn();
  const setHeader = vi.fn();
  const res = {
    req: { ip: '127.0.0.1', headers: { cookie: cookieHeader } },
    cookie,
    clearCookie,
    setHeader,
  } as unknown as Response;
  return { res, cookie, clearCookie, setHeader };
}

function setup(nodeEnv: 'test' | 'production' = 'test') {
  const cfg = config(nodeEnv);
  const csrf = new CsrfService(cfg);
  const auth = {
    login: vi.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', staff: STAFF }),
    refresh: vi.fn().mockResolvedValue({
      accessToken: 'next-access',
      refreshToken: 'next-refresh',
      refreshRotated: true,
    }),
    logout: vi.fn().mockResolvedValue(undefined),
    queuePasswordReset: vi.fn(),
  };
  const passwordResetThrottle = { consume: vi.fn().mockResolvedValue(undefined) };
  return {
    auth,
    csrf,
    passwordResetThrottle,
    controller: new AuthController(auth as unknown as AuthService, cfg, csrf, passwordResetThrottle as never),
  };
}

describe('AuthController cookie-only browser contract', () => {
  it('returns only safe staff from login and uses hardened production cookie names/paths', async () => {
    const { controller } = setup('production');
    const { res, cookie } = response();

    const result = await controller.login({ email: STAFF.email, password: 'password' }, res);

    expect(result).toEqual({ staff: STAFF });
    expect(JSON.stringify(result)).not.toContain('access');
    expect(JSON.stringify(result)).not.toContain('refresh');
    expect(cookie).toHaveBeenCalledWith(
      '__Host-th_access',
      'access',
      expect.objectContaining({ httpOnly: true, secure: true, path: '/' }),
    );
    expect(cookie).toHaveBeenCalledWith(
      '__Host-th_refresh',
      'refresh',
      expect.objectContaining({ httpOnly: true, secure: true, path: '/' }),
    );
    expect(cookie).toHaveBeenCalledWith(
      '__Host-th_csrf',
      expect.any(String),
      expect.objectContaining({ httpOnly: false, secure: true, path: '/' }),
    );
  });

  it('reads refresh only from the HttpOnly cookie and returns a non-secret shape', async () => {
    const { auth, controller } = setup();
    const { res } = response('th_refresh=raw-refresh');

    await expect(controller.refresh(res)).resolves.toEqual({ ok: true });
    expect(auth.refresh).toHaveBeenCalledWith('raw-refresh');
  });

  it('does not overwrite the winning refresh cookie for a concurrent-tab loser', async () => {
    const { auth, controller } = setup('production');
    auth.refresh.mockResolvedValueOnce({ accessToken: 'recovery-access', refreshRotated: false });
    const { res, cookie, clearCookie } = response('__Host-th_refresh=old-refresh');

    await expect(controller.refresh(res)).resolves.toEqual({ ok: true });

    expect(cookie).toHaveBeenCalledWith('__Host-th_access', 'recovery-access', expect.anything());
    expect(cookie).not.toHaveBeenCalledWith('__Host-th_refresh', expect.anything(), expect.anything());
    expect(clearCookie).not.toHaveBeenCalled();
  });

  it('reuses a valid API-host CSRF token when bootstrapped again', () => {
    const { controller, csrf } = setup();
    const token = csrf.createToken();
    const { res, cookie } = response(`th_csrf=${encodeURIComponent(token)}`);

    expect(controller.csrfToken(res)).toEqual({ csrfToken: token });
    expect(cookie).toHaveBeenCalledWith('th_csrf', token, expect.anything());
  });

  it('clears current and legacy cookies on every refresh failure', async () => {
    const { auth, controller } = setup('production');
    auth.refresh.mockRejectedValueOnce(new UnauthorizedException('stale'));
    const { res, clearCookie } = response('__Secure-th_refresh=stale');

    await expect(controller.refresh(res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(clearCookie).toHaveBeenCalledWith('__Secure-th_refresh', expect.objectContaining({ path: '/' }));
    expect(clearCookie).toHaveBeenCalledWith('__Host-th_refresh', expect.objectContaining({ path: '/' }));
    expect(clearCookie).toHaveBeenCalledWith('th_refresh', expect.objectContaining({ path: '/' }));
    expect(clearCookie).toHaveBeenCalledWith('th_access', expect.objectContaining({ path: '/' }));
  });

  it('clears cookies when the refresh cookie is missing without calling the service', async () => {
    const { auth, controller } = setup();
    const { res, clearCookie } = response();

    await expect(controller.refresh(res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.refresh).not.toHaveBeenCalled();
    expect(clearCookie).toHaveBeenCalled();
  });

  it('awaits revocation and clears current and legacy cookies on logout', async () => {
    const { auth, controller } = setup('production');
    const { res, clearCookie } = response();

    await controller.logout({ ...STAFF, jti: 'access-jti', exp: 1234 }, res);

    expect(auth.logout).toHaveBeenCalledWith(STAFF.staffId, 'access-jti', 1234);
    expect(clearCookie).toHaveBeenCalledWith('__Host-th_access', expect.objectContaining({ path: '/' }));
    expect(clearCookie).toHaveBeenCalledWith('__Host-th_refresh', expect.objectContaining({ path: '/' }));
    expect(clearCookie).toHaveBeenCalledWith('auth_token', expect.objectContaining({ path: '/' }));
  });

  it('checks the cluster quota then detaches reset delivery from response timing', async () => {
    const { auth, controller, passwordResetThrottle } = setup('production');
    const req = { ip: '203.0.113.9' } as Request;

    await expect(controller.forgotPassword({ email: 'victim@example.com' }, req)).resolves.toEqual({
      message: 'If that email is registered, a reset link has been sent.',
    });

    expect(passwordResetThrottle.consume).toHaveBeenCalledWith('victim@example.com', '203.0.113.9');
    expect(auth.queuePasswordReset).toHaveBeenCalledWith('victim@example.com');
  });
});
