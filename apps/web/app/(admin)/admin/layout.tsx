'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { ThemeToggle } from '@/components/premium/ThemeToggle';
import { useMe } from '@/lib/hooks/use-auth';
import { ADMIN_TAB_PERMISSIONS, hasPermission, hasAnyPermission } from '@/lib/auth/permissions';

// Each tab is gated by the permission that its screen's API requires. A Manager
// (no admin.* / staff.manage) therefore sees none of these and is redirected to
// the staff workspace; an admin sees all.
const ADMIN_TABS: { label: string; href: string }[] = [
  { label: 'Отделы', href: '/admin/departments' },
  { label: 'Статусы и приоритеты', href: '/admin/statuses' },
  { label: 'Типы заявок', href: '/admin/ticket-types' },
  { label: 'SLA-планы', href: '/admin/sla' },
  { label: 'Правила и макросы', href: '/admin/workflows' },
  { label: 'Сотрудники и группы', href: '/admin/staff' },
  { label: 'Пользовательские поля', href: '/admin/custom-fields' },
  { label: 'Почтовые очереди', href: '/admin/mail' },
  { label: 'Интеграция Alaris', href: '/admin/alaris' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: user, isLoading, isError } = useMe();

  // Tabs this principal may actually open, and whether they may be in /admin at all.
  const visibleTabs = ADMIN_TABS.filter((tab) => hasPermission(user, ADMIN_TAB_PERMISSIONS[tab.href]!));
  const canAccessAdmin = hasAnyPermission(user, Object.values(ADMIN_TAB_PERMISSIONS));
  const firstVisibleTabHref = visibleTabs[0]?.href;
  const currentTabIsAllowed = ADMIN_TABS.some(
    (tab) =>
      (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) &&
      hasPermission(user, ADMIN_TAB_PERMISSIONS[tab.href]!),
  );

  // Gate on `mounted` so SSR and the first client paint agree while `/auth/me`
  // resolves the HttpOnly-cookie session.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (isLoading) return;

    if (isError) {
      router.replace('/login');
      return;
    }

    // Permission-aware gate: anyone holding at least one admin-area permission
    // (admins, or a Manager granted a specific admin right) may enter; everyone
    // else is bounced to the staff workspace.
    if (user && !canAccessAdmin) {
      router.replace('/staff/dashboard');
      return;
    }

    // A direct URL (or stale browser tab) may point to an admin screen the
    // current principal cannot use. Move them to their first permitted tab
    // instead of leaving a page whose API requests all 403.
    if (user && pathname !== '/admin' && !currentTabIsAllowed) {
      router.replace(firstVisibleTabHref ?? '/staff/dashboard');
    }
  }, [isLoading, isError, user, router, canAccessAdmin, currentTabIsAllowed, firstVisibleTabHref, pathname]);

  // Brief loading state to avoid flicker.
  // `!mounted` keeps SSR and first client paint identical (see note above).
  if (!mounted || isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // While redirecting, render nothing
  if (isError || !user || !canAccessAdmin) {
    return null;
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Admin topbar */}
      <header className="sticky top-0 z-40 border-b border-border bg-card/90 backdrop-blur">
        <div className="flex h-14 items-center gap-4 px-6">
          <Link href="/staff/dashboard" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-brand text-white text-xs font-bold">
              23
            </div>
          </Link>
          <span className="text-sm font-semibold text-muted-foreground">/ Администрирование</span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        {/* Admin nav tabs */}
        <nav
          className="flex overflow-x-auto border-t border-border px-6"
          aria-label="Разделы администрирования"
        >
          {visibleTabs.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                data-active={active}
                aria-current={active ? 'page' : undefined}
                className="flex-shrink-0 border-b-2 border-transparent px-3 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground data-[active=true]:border-primary data-[active=true]:text-primary"
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
