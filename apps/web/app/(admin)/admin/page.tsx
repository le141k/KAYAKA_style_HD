'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useMe } from '@/lib/hooks/use-auth';
import { ADMIN_TAB_PERMISSIONS, hasPermission } from '@/lib/auth/permissions';

/**
 * Send each principal to their first permitted administration tab. The server
 * cannot see the HttpOnly session while rendering this page, so this must run
 * after `/auth/me` resolves on the client rather than hard-coding Departments.
 */
export default function AdminIndexPage() {
  const router = useRouter();
  const { data: user, isLoading } = useMe();

  useEffect(() => {
    if (isLoading || !user) return;
    const destination = Object.entries(ADMIN_TAB_PERMISSIONS).find(([, permission]) =>
      hasPermission(user, permission),
    )?.[0];
    router.replace(destination ?? '/staff/dashboard');
  }, [isLoading, router, user]);

  return (
    <div className="flex h-48 items-center justify-center" aria-label="Открываем доступный раздел">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}
