"use client";

import { useState, useEffect, useCallback } from "react";
import { SidebarNav } from "@/components/premium/SidebarNav";
import { CommandPalette } from "@/components/premium/CommandPalette";
import { NotificationBell } from "@/components/premium/NotificationBell";
import { ThemeToggle } from "@/components/premium/ThemeToggle";
import { LocaleSwitcher } from "@/components/premium/LocaleSwitcher";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getInitials } from "@/lib/utils";
import { useLogout } from "@/lib/hooks/use-auth";

// Mocked current user for shell display
const CURRENT_USER = { name: "Александр Петров", email: "a.petrov@23telecom.ru" };

export default function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [commandOpen, setCommandOpen] = useState(false);
  const { logout } = useLogout();

  // Global ⌘K hotkey
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setCommandOpen((v) => !v);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <SidebarNav onCommandPalette={() => setCommandOpen(true)} />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Topbar */}
        <header className="flex h-14 flex-shrink-0 items-center justify-end gap-2 border-b border-border bg-card/80 px-4 backdrop-blur">
          <LocaleSwitcher />
          <ThemeToggle />
          <NotificationBell />

          {/* User menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="flex items-center gap-2 rounded-md p-1 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Меню профиля"
              >
                <Avatar className="h-7 w-7">
                  <AvatarFallback className="text-[11px]">
                    {getInitials(CURRENT_USER.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden text-sm font-medium lg:block">
                  {CURRENT_USER.name}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <div className="px-2 py-1.5">
                <p className="text-xs font-medium">{CURRENT_USER.name}</p>
                <p className="text-xs text-muted-foreground">
                  {CURRENT_USER.email}
                </p>
              </div>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Профиль</DropdownMenuItem>
              <DropdownMenuItem>Настройки</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={logout}
              >
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

      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
      />
    </div>
  );
}
