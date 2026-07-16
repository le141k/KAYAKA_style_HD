'use client';

import React, { createContext, useContext, useMemo } from 'react';
import type { User } from '@/lib/types';
import { useMe } from '@/lib/hooks/use-auth';
import { hasPermission as principalHasPermission, hasAnyPermission } from '@/lib/auth/permissions';

interface AuthContextValue {
  user: User | null | undefined;
  isLoading: boolean;
  isAuthenticated: boolean;
  isAdmin: boolean;
  permissions: string[];
  /** True if the current user holds `perm` (admins inherit everything). */
  can: (perm: string) => boolean;
  /** True if the current user holds at least one of `perms`. */
  canAny: (perms: readonly string[]) => boolean;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: false,
  isAuthenticated: false,
  isAdmin: false,
  permissions: [],
  can: () => false,
  canAny: () => false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading } = useMe();

  const value = useMemo<AuthContextValue>(() => {
    const principal = user ?? null;
    return {
      user: principal,
      isLoading,
      isAuthenticated: !!principal,
      isAdmin: !!principal?.isAdmin,
      permissions: principal?.permissions ?? [],
      can: (perm: string) => principalHasPermission(principal, perm),
      canAny: (perms: readonly string[]) => hasAnyPermission(principal, perms),
    };
  }, [user, isLoading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
