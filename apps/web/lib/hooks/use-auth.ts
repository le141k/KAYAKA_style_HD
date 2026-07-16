'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
import { api, hasToken } from '@/lib/api';
import type { User, LoginResponse } from '@/lib/types';
import { deriveRole } from '@/lib/auth/permissions';

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
  const permissions = p.permissions ?? [];
  return {
    id: p.staffId,
    name,
    email: p.email,
    // Distinguish Manager from Agent instead of collapsing every non-admin to
    // 'agent'; carry the raw permissions so the UI can gate by concrete rights.
    role: deriveRole(p.isAdmin, permissions),
    isAdmin: p.isAdmin,
    permissions,
  } as User;
}

export function useMe() {
  const pathname = usePathname();
  // AuthProvider is mounted around the whole app. Avoid trying to recover a
  // stale staff session on public pages (especially /login), where a failed
  // login must remain a normal form error rather than trigger refresh rotation.
  const isStaffArea =
    pathname === '/staff' ||
    pathname?.startsWith('/staff/') ||
    pathname === '/admin' ||
    pathname?.startsWith('/admin/');

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
    enabled: hasToken() && isStaffArea,
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
        // The access + refresh JWTs are set as HttpOnly cookies by the server on this
        // same response — JS never stores them (XSS can't read them). We only set a
        // non-sensitive presence marker so hasToken() and the Next.js middleware can
        // guard /staff and /admin without exposing the token.
        document.cookie = `th_authed=1; path=/; max-age=${7 * 86400}; SameSite=Lax`;
        // Drop any tokens persisted by older builds.
        localStorage.removeItem('auth_token');
        localStorage.removeItem('refresh_token');
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
