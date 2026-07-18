'use client';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

// The access/refresh JWTs live ONLY in server-set HttpOnly cookies (invisible to
// JS), so an XSS payload cannot read or exfiltrate them. This non-sensitive marker
// cookie carries no token — it only lets JS (hasToken) and the Next.js middleware
// distinguish "logged in" vs "anonymous" for coarse route guarding.
const PRESENCE_COOKIE = 'th_authed';
const CSRF_COOKIE_NAMES = ['__Host-th_csrf', 'th_csrf'] as const;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let csrfBootstrap: Promise<string> | null = null;

/**
 * Bootstrap the signed readable CSRF cookie once per page lifecycle.
 *
 * Do not trust a pre-existing cookie before this call: it may have been signed
 * with the previous access secret after a normal production key rotation.  The
 * server reuses a valid token and replaces an invalid one.
 */
export async function getCsrfToken(): Promise<string> {
  if (csrfBootstrap) return csrfBootstrap;
  csrfBootstrap = fetch(`${API_URL}/auth/csrf`, { credentials: 'include', cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error(`Unable to obtain CSRF token (${res.status})`);
      const body = (await res.json()) as { csrfToken?: string };
      if (!body.csrfToken) throw new Error('CSRF response did not contain a token');
      return body.csrfToken;
    })
    .catch((error: unknown) => {
      // A transient bootstrap failure must not poison the page forever.
      csrfBootstrap = null;
      throw error;
    });
  return csrfBootstrap;
}

function resetCsrfBootstrap(): void {
  csrfBootstrap = null;
}

async function isInvalidCsrfResponse(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  try {
    const data = (await res.clone().json()) as { code?: unknown };
    return data.code === 'CSRF_TOKEN_INVALID';
  } catch {
    return false;
  }
}

/**
 * Browser fetch with signed-CSRF bootstrap and one guard-safe recovery retry.
 * Callers keep control of response/error handling and request body encoding.
 */
export async function fetchWithCsrf(
  input: RequestInfo | URL,
  init: RequestInit = {},
  _csrfRetry = false,
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (!SAFE_METHODS.has(method)) headers['X-CSRF-Token'] = await getCsrfToken();

  const res = await fetch(input, {
    ...init,
    headers,
    credentials: init.credentials ?? 'include',
  });
  if (!_csrfRetry && !SAFE_METHODS.has(method) && (await isInvalidCsrfResponse(res))) {
    // CsrfGuard rejects before the controller runs, so replaying only this
    // machine-readable failure cannot duplicate an already-applied mutation.
    resetCsrfBootstrap();
    await getCsrfToken();
    return fetchWithCsrf(input, init, true);
  }
  return res;
}

function clearTokens(): void {
  if (typeof window === 'undefined') return;
  resetCsrfBootstrap();
  document.cookie = `${PRESENCE_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  for (const name of CSRF_COOKIE_NAMES) {
    const hardenedAttributes = name.startsWith('__Host-') ? '; Secure; SameSite=Lax' : '';
    document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT${hardenedAttributes}`;
  }
  // Clean up any tokens left in localStorage / non-HttpOnly cookie by older builds.
  localStorage.removeItem('auth_token');
  localStorage.removeItem('refresh_token');
  document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';

  // The real credential cookies are HttpOnly and therefore cannot be removed from
  // here. Once refresh failed, keeping a protected React tree mounted only turns
  // every data query into a misleading "could not load" error. Move the user to
  // the login screen instead, where a successful login replaces those cookies.
  if (/^\/(?:staff|admin)(?:\/|$)/.test(window.location.pathname)) {
    window.location.replace('/login');
  }
}

/**
 * A failed login is an expected authentication result, not a signal that an old
 * browser session should be refreshed. Refreshing after `/auth/login` returns
 * 401 can replay a stale refresh cookie and trigger server-side reuse detection.
 * `/auth/me` is the one protected auth endpoint that legitimately may refresh.
 */
export function canRefreshAfterUnauthorized(path: string): boolean {
  return !path.startsWith('/auth/') || path === '/auth/me' || path === '/auth/logout';
}

/** Attempt a token refresh using the HttpOnly th_refresh cookie. */
let _refreshing: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  // Coalesce concurrent refresh attempts
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      // The refresh token is the HttpOnly th_refresh cookie, sent automatically via
      // credentials:'include'. The server rotates the th_access cookie on success.
      const res = await fetchWithCsrf(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      return true;
    } catch {
      clearTokens();
      return false;
    } finally {
      _refreshing = null;
    }
  })();
  return _refreshing;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, options: RequestInit = {}, _authRetry = false): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  // Auth is the HttpOnly cookie, sent automatically by credentials:'include'.
  // No Authorization header — the JWT is never read into JS.
  const res = await fetchWithCsrf(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (res.status === 401 && !_authRetry && canRefreshAfterUnauthorized(path)) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      // Retry the original request once with the new token
      return request<T>(path, options, true);
    }
    // Refresh failed — throw so callers can redirect to login
    throw new ApiError(401, 'Unauthorized');
  }

  if (!res.ok) {
    let data: unknown;
    try {
      data = await res.json();
    } catch {}
    throw new ApiError(res.status, `HTTP ${res.status}`, data);
  }

  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown, options: RequestInit = {}) =>
    request<T>(path, { ...options, method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
