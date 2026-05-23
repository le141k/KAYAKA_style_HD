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
import { hasToken } from '@/lib/api';
import { useLogout, useMe } from '@/lib/hooks/use-auth';

export default function StaffLayout({ children }: { children: React.ReactNode }) {
  const [commandOpen, setCommandOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { logout } = useLogout();
  const router = useRouter();
  const { data: user, isLoading, isError } = useMe();

  // `useMe` is `enabled: hasToken()`, which is false during SSR (no
  // localStorage) but true on the client once authenticated. That makes the
  // server render `null` while the first client paint renders the spinner —
  // a hydration mismatch (#418). Gate on `mounted` so both render the loader
  // first, then resolve auth purely on the client.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Auth guard: redirect to /login if not authenticated / API returns error.
  // hasToken() reads the non-sensitive th_authed presence marker (the JWT lives
  // only in HttpOnly cookies, unreadable from JS).
  useEffect(() => {
    if (isLoading) return;
    if (!hasToken() || isError) {
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
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/admin/staff">Профиль</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/admin">Настройки</Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={logout}>
                Выйти
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
