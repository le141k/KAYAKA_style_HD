'use client';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

// Cookie name set non-HttpOnly by the legacy client; the auth source of truth is
// now the server-set HttpOnly cookie (invisible to JS). This local marker cookie
// only exists so the Next.js middleware can do a coarse server-side route guard
// without the token value leaking to JS XSS in a usable way.
const PRESENCE_COOKIE = 'th_authed';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  // Bearer fallback for the legacy localStorage flow. When absent, requests still
  // authenticate via the HttpOnly cookie sent automatically with credentials:'include'.
  return localStorage.getItem('auth_token');
}

/**
 * True when the user appears authenticated. Checks the localStorage token (legacy
 * Bearer flow) OR the th_authed presence marker cookie (cookie flow). We can't read
 * the HttpOnly cookie from JS, so we rely on the presence marker set at login.
 */
export function hasToken(): boolean {
  if (typeof window === 'undefined') return false;
  if (localStorage.getItem('auth_token') != null) return true;
  return document.cookie.split('; ').some((row) => row.startsWith(`${PRESENCE_COOKIE}=`));
}

function storeTokens(accessToken: string): void {
  if (typeof window === 'undefined') return;
  // Keep the localStorage copy so the Bearer fallback keeps working seamlessly.
  // The authoritative access token also arrives as an HttpOnly cookie from the server.
  localStorage.setItem('auth_token', accessToken);
}

function clearTokens(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('auth_token');
  localStorage.removeItem('refresh_token');
  document.cookie = `${PRESENCE_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  // Clean up the legacy non-HttpOnly token cookie if it lingers from an old session.
  document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

/** Attempt a token refresh. Returns true if a new token was stored. */
let _refreshing: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  // Coalesce concurrent refresh attempts
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    try {
      const refreshToken = typeof window !== 'undefined' ? localStorage.getItem('refresh_token') : null;
      // No body refresh token means we rely on the HttpOnly th_refresh cookie sent
      // via credentials:'include'. Only bail if BOTH are unavailable.
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      });
      if (!res.ok) {
        clearTokens();
        return false;
      }
      const data = (await res.json()) as { accessToken: string };
      storeTokens(data.accessToken);
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

async function request<T>(path: string, options: RequestInit = {}, _retry = false): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // credentials:'include' sends the HttpOnly auth cookie alongside (or instead of)
  // the Bearer header — the API guard accepts either.
  const res = await fetch(`${API_URL}${path}`, { ...options, headers, credentials: 'include' });

  if (res.status === 401 && !_retry) {
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
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
