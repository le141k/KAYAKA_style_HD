import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { middleware } from './middleware';

function request(cookieNames: string[]): NextRequest {
  return {
    url: 'https://helpdesk.example/staff/dashboard',
    nextUrl: { pathname: '/staff/dashboard' },
    cookies: { has: (name: string) => cookieNames.includes(name) },
  } as unknown as NextRequest;
}

describe('staff route middleware', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('allows a production hard navigation with only the refresh cookie', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const response = middleware(request(['__Host-th_refresh']));

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('redirects a production request with no server-visible session cookie', () => {
    vi.stubEnv('NODE_ENV', 'production');

    const response = middleware(request([]));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://helpdesk.example/login?next=%2Fstaff%2Fdashboard');
  });
});
