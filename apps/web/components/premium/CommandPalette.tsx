"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Ticket,
  KanbanSquare,
  BookOpen,
  Settings,
  Users,
  Search,
  ArrowRight,
} from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { useTickets } from "@/lib/hooks/use-tickets";

const NAV_ITEMS = [
  { label: "Дашборд", href: "/staff/dashboard", Icon: LayoutDashboard },
  { label: "Заявки (список)", href: "/staff/tickets", Icon: Ticket },
  { label: "Канбан", href: "/staff/kanban", Icon: KanbanSquare },
  { label: "База знаний", href: "/kb", Icon: BookOpen },
  { label: "Настройки", href: "/admin", Icon: Settings },
  { label: "Сотрудники", href: "/admin/staff", Icon: Users },
];

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const { data } = useTickets({ q: query || undefined, per_page: 5 });
  const tickets = data?.data ?? [];

  const navigate = useCallback(
    (href: string) => {
      router.push(href);
      onClose();
      setQuery("");
    },
    [router, onClose]
  );

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

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
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="fixed left-[50%] top-[20%] z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
            role="dialog"
            aria-label="Командная строка"
          >
            <Command shouldFilter={false} onValueChange={() => {}}>
              <CommandInput
                placeholder="Поиск заявок, разделов..."
                value={query}
                onValueChange={setQuery}
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
                  {NAV_ITEMS.filter((item) =>
                    query
                      ? item.label.toLowerCase().includes(query.toLowerCase())
                      : true
                  ).map((item) => (
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
                          onSelect={() =>
                            navigate(`/staff/tickets/${ticket.id}`)
                          }
                          className="gap-3"
                        >
                          <span className="font-mono text-xs text-muted-foreground">
                            {ticket.mask}
                          </span>
                          <span className="line-clamp-1 flex-1 text-sm">
                            {ticket.subject}
                          </span>
                          <ArrowRight className="h-3 w-3 opacity-40" />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </>
                )}
              </CommandList>

              {/* Footer hint */}
              <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">↑↓</kbd>{" "}
                навигация·{" "}
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">↵</kbd>{" "}
                выбрать·{" "}
                <kbd className="rounded bg-muted px-1.5 py-0.5 font-mono">Esc</kbd>{" "}
                закрыть
              </div>
            </Command>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
