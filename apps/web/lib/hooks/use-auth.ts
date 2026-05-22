'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
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

export function useMe() {
  return useQuery({
    queryKey: authKeys.me,
    queryFn: async (): Promise<User> => {
      const p = await api.get<MePrincipal>('/auth/me');
      return {
        id: p.staffId,
        name: p.email,
        email: p.email,
        role: p.isAdmin ? 'admin' : 'agent',
      } as User;
    },
    retry: false,
    staleTime: 5 * 60_000,
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
      // /auth/me returns the staff principal; map onto the cached display user.
      qc.setQueryData(authKeys.me, res.staff as unknown as User);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return {
    logout: () => {
      if (typeof window !== 'undefined') {
        localStorage.removeItem('auth_token');
        document.cookie = 'auth_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      }
      qc.clear();
      window.location.href = '/login';
    },
  };
}
