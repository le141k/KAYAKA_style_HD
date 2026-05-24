'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Ticket,
  KanbanSquare,
  Settings,
  ChevronLeft,
  ChevronRight,
  Command,
  BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useAuth } from '@/lib/auth/auth-context';

const NAV_ITEMS = [
  { label: 'Дашборд', href: '/staff/dashboard', Icon: LayoutDashboard, adminOnly: false },
  { label: 'Заявки', href: '/staff/tickets', Icon: Ticket, adminOnly: false },
  { label: 'Канбан', href: '/staff/kanban', Icon: KanbanSquare, adminOnly: false },
  { label: 'База знаний', href: '/kb', Icon: BookOpen, adminOnly: false },
  { label: 'Настройки', href: '/admin', Icon: Settings, adminOnly: true },
];

interface SidebarNavProps {
  onCommandPalette?: () => void;
}

export function SidebarNav({ onCommandPalette }: SidebarNavProps) {
  const [collapsed, setCollapsed] = useState(false);
  const pathname = usePathname();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const visibleItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <TooltipProvider delayDuration={200}>
      <motion.nav
        animate={{ width: collapsed ? 64 : 220 }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className="relative flex h-screen flex-col border-r border-border bg-card"
        aria-label="Боковая навигация"
      >
        {/* Logo */}
        <div
          className={cn(
            'flex h-14 items-center border-b border-border px-4',
            collapsed ? 'justify-center' : 'gap-3',
          )}
        >
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-brand text-white">
            <span className="text-sm font-bold">23</span>
          </div>
          <AnimatePresence>
            {!collapsed && (
              <motion.span
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                className="overflow-hidden whitespace-nowrap text-sm font-semibold"
              >
                23T Help Desk
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* Command palette shortcut */}
        {onCommandPalette && (
          <div className="px-3 py-2">
            <button
              onClick={onCommandPalette}
              className={cn(
                'flex w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted',
                collapsed && 'justify-center px-0',
              )}
              aria-label="Открыть командную строку (⌘K)"
            >
              <Command className="h-3.5 w-3.5 flex-shrink-0" />
              <AnimatePresence>
                {!collapsed && (
                  <motion.span
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex-1 text-left"
                  >
                    Поиск...
                  </motion.span>
                )}
              </AnimatePresence>
              {!collapsed && <kbd className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">⌘K</kbd>}
            </button>
          </div>
        )}

        {/* Nav items */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          <ul className="space-y-0.5" role="list">
            {visibleItems.map((item) => {
              const isActive =
                pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));

              const navItem = (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      'group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      'hover:bg-primary/10 hover:text-primary',
                      isActive ? 'bg-primary/10 text-primary' : 'text-muted-foreground',
                      collapsed && 'justify-center px-0 py-2.5',
                    )}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    {/* Active indicator glow */}
                    {isActive && (
                      <motion.span
                        layoutId="active-nav"
                        className="absolute inset-0 rounded-md bg-primary/10"
                        transition={{ duration: 0.2 }}
                      />
                    )}
                    <item.Icon
                      className={cn(
                        'relative h-4 w-4 flex-shrink-0 transition-colors',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                    <AnimatePresence>
                      {!collapsed && (
                        <motion.span
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="relative"
                        >
                          {item.label}
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </Link>
                </li>
              );

              if (collapsed) {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>{navItem}</TooltipTrigger>
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                );
              }

              return navItem;
            })}
          </ul>
        </div>

        {/* Collapse toggle */}
        <div className="border-t border-border p-2">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="flex w-full items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>
      </motion.nav>
    </TooltipProvider>
  );
}
