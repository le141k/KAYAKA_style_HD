'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, hasToken } from '@/lib/api';
import type { User, LoginResponse } from '@/lib/types';

export const authKeys = {
  me: ['auth', 'me'] as const,
};

interface MePrincipal {
  staffId: number;
  email: string;
  isAdmin: boolean;
  permissions: string[];
  firstName?: string;
  lastName?: string;
  fullName?: string;
}

function principalToUser(p: MePrincipal): User {
  const name = p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email;
  return {
    id: p.staffId,
    name,
    email: p.email,
    role: p.isAdmin ? 'admin' : 'agent',
  } as User;
}

export function useMe() {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: async (): Promise<User> => {
      const p = await api.get<MePrincipal>('/auth/me');
      return principalToUser(p);
    },
    retry: false,
    staleTime: 5 * 60_000,
    // Don't fire /auth/me when unauthenticated — avoids the noisy 401 on every
    // public/unauthenticated page load. Layout guards check hasToken separately.
    enabled: hasToken(),
  });
}

export interface LoginInput {
  email: string;
  password: string;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: LoginInput) => api.post<LoginResponse>('/auth/login', data),
    onSuccess: (res) => {
      if (typeof window !== 'undefined') {
        // Keep localStorage tokens for the Bearer fallback (backward compatible).
        // The authoritative access + refresh tokens are ALSO set as HttpOnly cookies
        // by the server on this same response, so JS never needs the raw token.
        localStorage.setItem('auth_token', res.accessToken);
        localStorage.setItem('refresh_token', res.refreshToken);
        // Non-sensitive presence marker so the Next.js middleware can guard /staff
        // and /admin server-side without exposing the token to JS.
        document.cookie = `th_authed=1; path=/; max-age=${7 * 86400}; SameSite=Lax`;
      }
      // Map the returned staff principal to the same display User shape as useMe()
      const user: User = principalToUser({
        staffId: res.staff.staffId,
        email: res.staff.email,
        isAdmin: res.staff.isAdmin,
        permissions: res.staff.permissions,
        firstName: res.staff.firstName,
        lastName: res.staff.lastName,
        fullName: res.staff.fullName,
      });
      qc.setQueryData(authKeys.me, user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return {
    logout: () => {
      // Tell the server to revoke refresh tokens and clear the HttpOnly cookies.
      // Fire-and-forget: we redirect regardless of the result.
      void api.post('/auth/logout', {}).catch(() => undefined);
      if (typeof window !== 'undefined') {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('refresh_token');
        document.cookie = 'th_authed=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        // Clear the legacy non-HttpOnly token cookie too, in case it lingers.
        document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      }
      qc.clear();
      window.location.href = '/login';
    },
  };
}
