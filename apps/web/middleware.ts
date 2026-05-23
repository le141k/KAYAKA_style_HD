import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Server-side route guard for the staff/admin areas.
 *
 * Runs on the Edge before the page renders. It treats a request as authenticated
 * when EITHER auth signal is present:
 *   - `th_access`  — the HttpOnly access-token cookie set by the API on login/refresh
 *                    (the new, XSS-safe source of truth). Middleware runs server-side
 *                    so it can read HttpOnly cookies.
 *   - `th_authed`  — a non-sensitive presence marker set by the web client at login
 *                    (covers the dual-mode/Bearer-fallback flow where the API cookie
 *                    may not yet be on this origin).
 *
 * This is a coarse gate (presence only, not signature verification — the API still
 * enforces real JWT validation on every call); its job is to bounce anonymous users
 * away from /staff and /admin before they hit a client-only page.
 */
export function middleware(req: NextRequest): NextResponse {
  const hasAuth =
    req.cookies.has('th_access') || req.cookies.has('th_authed') || req.cookies.has('auth_token');

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
