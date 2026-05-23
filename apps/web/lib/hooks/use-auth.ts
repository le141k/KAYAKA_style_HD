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
}

function principalToUser(p: MePrincipal): User {
  return {
    id: p.staffId,
    name: p.email,
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
        localStorage.setItem('auth_token', res.accessToken);
        localStorage.setItem('refresh_token', res.refreshToken);
        // also set cookie for SSR / middleware
        document.cookie = `auth_token=${res.accessToken}; path=/; max-age=${7 * 86400}; SameSite=Strict`;
      }
      // Map the returned staff principal to the same display User shape as useMe()
      const user: User = principalToUser({
        staffId: res.staff.staffId,
        email: res.staff.email,
        isAdmin: res.staff.isAdmin,
        permissions: res.staff.permissions,
      });
      qc.setQueryData(authKeys.me, user);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return {
    logout: () => {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('refresh_token');
        document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      }
      qc.clear();
      window.location.href = '/login';
    },
  };
}
