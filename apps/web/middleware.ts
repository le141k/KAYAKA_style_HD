import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Server-side route guard for the staff/admin areas.
 *
 * Runs on the Edge before the page renders. It treats a request as authenticated
 * when a server-visible session cookie is present:
 *   - `__Host-th_access` (prod) / `th_access` (dev) — the HttpOnly access-token
 *                    cookie set by the API on login/refresh
 *                    (the new, XSS-safe source of truth). Middleware runs server-side
 *                    so it can read HttpOnly cookies.
 *   - `__Host-th_refresh` (prod) / `th_refresh` (dev) — lets a hard navigation
 *                    recover an expired 15-minute access cookie via `/auth/me`.
 *   - `th_authed`  — a non-sensitive development-only presence marker set at login
 *                    (covers deployments where the API's host-only credential cookie
 *                    lives on a separate API hostname).
 *
 * This is a coarse gate (presence only, not signature verification — the API still
 * enforces real JWT validation on every call); its job is to bounce anonymous users
 * away from /staff and /admin before they hit a client-only page.
 */
export function middleware(req: NextRequest): NextResponse {
  // Production is same-origin and trusts only the domain-cookie-proof __Host
  // credential. Dev keeps the marker fallback for split localhost ports.
  const hasAuth =
    process.env.NODE_ENV === 'production'
      ? req.cookies.has('__Host-th_access') || req.cookies.has('__Host-th_refresh')
      : req.cookies.has('th_access') || req.cookies.has('th_refresh') || req.cookies.has('th_authed');

  if (!hasAuth) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Guard the staff and admin areas only. Public pages, the client portal, login,
  // and Next internals are intentionally excluded.
  matcher: ['/staff/:path*', '/admin/:path*'],
};
