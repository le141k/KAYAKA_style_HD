'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { ThemeToggle } from '@/components/premium/ThemeToggle';
import { useMe } from '@/lib/hooks/use-auth';

const ADMIN_TABS = [
  { label: 'Отделы', href: '/admin/departments' },
  { label: 'Статусы и приоритеты', href: '/admin/statuses' },
  { label: 'SLA-планы', href: '/admin/sla' },
  { label: 'Правила и макросы', href: '/admin/workflows' },
  { label: 'Сотрудники и группы', href: '/admin/staff' },
  { label: 'Пользовательские поля', href: '/admin/custom-fields' },
  { label: 'Интеграция Alaris', href: '/admin/alaris' },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: user, isLoading, isError } = useMe();

  useEffect(() => {
    if (isLoading) return;

    const hasToken =
      typeof window !== 'undefined' &&
      (localStorage.getItem('auth_token') ||
        document.cookie.split('; ').some((r) => r.startsWith('auth_token=')));

    if (!hasToken || isError) {
      router.replace('/login');
      return;
    }

    if (user && user.role !== 'admin') {
      router.replace('/staff/dashboard');
    }
  }, [isLoading, isError, user, router]);

  // Brief loading state to avoid flicker
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // While redirecting, render nothing
  if (isError || !user || user.role !== 'admin') {
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
          {ADMIN_TABS.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className="flex-shrink-0 border-b-2 border-transparent px-3 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground data-[active=true]:border-primary data-[active=true]:text-primary"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
