'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Ticket,
  KanbanSquare,
  BookOpen,
  Settings,
  Users,
  Search,
  ArrowRight,
} from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useTickets } from '@/lib/hooks/use-tickets';
import { useAuth } from '@/lib/auth/auth-context';
import { ADMIN_AREA_PERMISSIONS, PERMISSIONS } from '@/lib/auth/permissions';

// `requires` (when set) gates the command behind holding at least one of the
// listed permissions — matches the permission-aware sidebar/admin nav.
const NAV_ITEMS: { label: string; href: string; Icon: typeof LayoutDashboard; requires?: string[] }[] = [
  { label: 'Дашборд', href: '/staff/dashboard', Icon: LayoutDashboard },
  { label: 'Заявки (список)', href: '/staff/tickets', Icon: Ticket },
  { label: 'Канбан', href: '/staff/kanban', Icon: KanbanSquare },
  { label: 'База знаний', href: '/kb', Icon: BookOpen },
  { label: 'Настройки', href: '/admin', Icon: Settings, requires: ADMIN_AREA_PERMISSIONS },
  { label: 'Сотрудники', href: '/admin/staff', Icon: Users, requires: [PERMISSIONS.STAFF_MANAGE] },
];

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const { canAny } = useAuth();

  const [inputValue, setInputValue] = useState('');
  // Debounced query sent to the API — updated ~300 ms after the user stops typing.
  const [query, setQuery] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setQuery(value);
    }, 300);
  }, []);

  const { data } = useTickets({ q: query || undefined, per_page: 5, enabled: open });
  const tickets = data?.data ?? [];

  const navigate = useCallback(
    (href: string) => {
      router.push(href);
      onClose();
      setInputValue('');
      setQuery('');
    },
    [router, onClose],
  );

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Reset state when palette is closed
  useEffect(() => {
    if (!open) {
      setInputValue('');
      setQuery('');
      if (debounceRef.current) clearTimeout(debounceRef.current);
    }
  }, [open]);

  const visibleNavItems = NAV_ITEMS.filter((item) => {
    if (item.requires && !canAny(item.requires)) return false;
    return inputValue ? item.label.toLowerCase().includes(inputValue.toLowerCase()) : true;
  });

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -12 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="fixed left-[50%] top-[20%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
            role="dialog"
            aria-label="Командная строка"
          >
            <Command shouldFilter={false} onValueChange={() => {}}>
              <CommandInput
                placeholder="Поиск заявок, разделов..."
                value={inputValue}
                onValueChange={handleInputChange}
                autoFocus
              />
              <CommandList className="max-h-80">
                <CommandEmpty>
                  <div className="flex flex-col items-center gap-2 py-8 text-muted-foreground">
                    <Search className="h-8 w-8 opacity-40" />
                    <p className="text-sm">Ничего не найдено</p>
                  </div>
                </CommandEmpty>

                {/* Navigation */}
                <CommandGroup heading="Навигация">
                  {visibleNavItems.map((item) => (
                    <CommandItem
                      key={item.href}
                      value={item.href}
                      onSelect={() => navigate(item.href)}
                      className="gap-3"
                    >
                      <item.Icon className="h-4 w-4 text-muted-foreground" />
                      <span>{item.label}</span>
                      <ArrowRight className="ml-auto h-3 w-3 opacity-40" />
                    </CommandItem>
                  ))}
                </CommandGroup>

                {/* Ticket search results */}
                {query && tickets.length > 0 && (
                  <>
                    <CommandSeparator />
                    <CommandGroup heading="Заявки">
                      {tickets.map((ticket) => (
                        <CommandItem
                          key={ticket.id}
                          value={`ticket-${ticket.id}`}
                          onSelect={() => navigate(`/staff/tickets/${ticket.id}`)}
                          className="gap-3"
                        >
                          <span className="font-mono text-xs text-muted-foreground">{ticket.mask}</span>
                          <span className="line-clamp-1 flex-1 text-sm">{ticket.subject}</span>
                          <ArrowRight className="h-3 w-3 opacity-40" />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>

              {/* Footer hint */}
              <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">↑↓</kbd> навигация·{' '}
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">↵</kbd> выбрать·{' '}
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">Esc</kbd> закрыть
              </div>
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
