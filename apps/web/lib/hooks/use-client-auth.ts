'use client';

/**
 * Client (customer) portal auth — the verified magic-link session (GOAL_PUBLIC_SECURITY S2).
 *
 * Distinct from the staff JWT flow: a customer requests a sign-in link, opens it, and the
 * `/verify` page exchanges the single-use token for an HttpOnly `th_client` session cookie.
 * Every request below is a raw `fetch` with `credentials:'include'` so the cookie rides along —
 * deliberately NOT the shared `api` client, whose 401 handler would trigger a STAFF token
 * refresh and blur the staff/client boundary.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

/** A client-domain fetch. Throws `{ status }` on a non-2xx response. */
export async function clientFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export interface ClientPrincipal {
  userId: number;
}

export const clientAuthKeys = {
  session: ['client-auth', 'session'] as const,
};

// Mirrors `clientTicketKeys.all` in use-client-tickets — kept as a literal here to avoid an
// import cycle. On any session change we drop the previous principal's ticket cache so no prior
// user's data can linger in memory across a sign-out / re-sign-in.
const CLIENT_TICKETS_KEY = ['client-tickets'] as const;

/**
 * Current client session, resolved from the `th_client` cookie via GET /client-auth/me.
 * Returns `null` (not an error) when unauthenticated, so a page can branch cleanly.
 */
export function useClientSession() {
  return useQuery({
    queryKey: clientAuthKeys.session,
    queryFn: async (): Promise<ClientPrincipal | null> => {
      try {
        return await clientFetch<ClientPrincipal>('/client-auth/me');
      } catch (e) {
        if ((e as { status?: number }).status === 401) return null; // simply not signed in
        throw e; // a real failure (network/5xx) must surface
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

/** Request a sign-in link. Always resolves 202 — never reveals whether the email exists. */
export function useRequestClientLink() {
  return useMutation({
    mutationFn: (email: string) =>
      clientFetch<{ message: string }>('/client-auth/request-link', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
  });
}

/** Exchange a single-use login token (from the email fragment) for a session cookie. */
export function useVerifyClientToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      clientFetch<{ ok: boolean; expiresAt: string }>('/client-auth/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: CLIENT_TICKETS_KEY });
      void qc.invalidateQueries({ queryKey: clientAuthKeys.session });
    },
  });
}

/** Revoke the current client session and clear the cookie. */
export function useClientLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => clientFetch<void>('/client-auth/logout', { method: 'POST' }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: CLIENT_TICKETS_KEY }); // drop the signed-out user's tickets
      void qc.invalidateQueries({ queryKey: clientAuthKeys.session });
    },
  });
}
