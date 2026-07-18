'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Menu, Loader2 } from 'lucide-react';
import { SidebarNav } from '@/components/premium/SidebarNav';
import { CommandPalette } from '@/components/premium/CommandPalette';
import { ThemeToggle } from '@/components/premium/ThemeToggle';
import { LocaleSwitcher } from '@/components/premium/LocaleSwitcher';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { getInitials } from '@/lib/utils';
import { useLogout, useMe } from '@/lib/hooks/use-auth';
import { useI18n } from '@/lib/i18n';
import { ADMIN_AREA_PERMISSIONS, ROLE_LABEL, hasAnyPermission } from '@/lib/auth/permissions';

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { logout } = useLogout();
  const { t } = useI18n();
  const router = useRouter();
  const { data: user, isLoading, isError } = useMe();

  // Gate on `mounted` so SSR and the first client paint both render the loader,
  // then resolve the HttpOnly-cookie session through `/auth/me`.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Auth guard: the API is authoritative; JS-readable marker expiry is not.
  useEffect(() => {
    if (isLoading) return;
    if (isError) {
      router.replace('/login');
    }
  }, [isLoading, isError, router]);

  // Global ⌘K hotkey
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
      e.preventDefault();
      setCommandOpen((v) => !v);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Brief loading state to avoid flicker before auth resolves.
  // `!mounted` keeps SSR and first client paint identical (see note above).
  if (!mounted || isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // While redirecting (no token / error), render nothing
  if (isError || !user) {
    return null;
  }

  const displayName = user.name;
  const displayEmail = user.email;
  const canAccessAdmin = hasAnyPermission(user, ADMIN_AREA_PERMISSIONS);
  const roleLabel = user.role === 'client' ? undefined : ROLE_LABEL[user.role];

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop sidebar */}
      <div className="hidden md:block">
        <SidebarNav onCommandPalette={() => setCommandOpen(true)} />
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-2 border-b border-border bg-card/80 px-4 backdrop-blur md:justify-end">
          {/* Mobile nav trigger */}
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 md:hidden"
                aria-label="Открыть навигацию"
              >
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-[220px]">
              <SheetHeader className="sr-only">
                <SheetTitle>Навигация</SheetTitle>
              </SheetHeader>
              <SidebarNav
                onCommandPalette={() => {
                  setMobileNavOpen(false);
                  setCommandOpen(true);
                }}
              />
            </SheetContent>
          </Sheet>
          <LocaleSwitcher />
          <ThemeToggle />
          {/* NotificationBell intentionally removed: there is no real notifications
              feed yet, and showing an always-empty mock would be a fake UI. Re-add
              once a /notifications endpoint exists. */}

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Меню профиля"
              >
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="text-[11px]">{getInitials(displayName)}</AvatarFallback>
                </Avatar>
                <span className="hidden text-sm font-medium lg:block">{displayName}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5">
                <p className="text-xs font-medium">{displayName}</p>
                <p className="text-xs text-muted-foreground">{displayEmail}</p>
                {roleLabel && (
                  <span className="mt-1 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                    {roleLabel}
                  </span>
                )}
              </div>
              <DropdownMenuSeparator />
              {/* Settings is permission-gated: shown to admins and any Manager who
                  holds at least one admin-area permission. Members without one are
                  bounced by the admin guard, so hiding the dead link is correct. */}
              {canAccessAdmin && (
                <>
                  <DropdownMenuItem asChild>
                    <Link href="/admin">Настройки</Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={logout}>
                {t.nav.logout}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          <div className="h-full">{children}</div>
        </main>
      </div>

      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
    </div>
  );
}
