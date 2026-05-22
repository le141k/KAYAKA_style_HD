"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Search, SlidersHorizontal, LayoutGrid } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TicketRow } from "@/components/premium/TicketRow";
import { TicketListSkeleton } from "@/components/premium/SkeletonLoaders";
import { useTickets } from "@/lib/hooks/use-tickets";
import { useI18n } from "@/lib/i18n";
import Link from "next/link";

export function TicketsListContent() {
  const { t } = useI18n();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [priority, setPriority] = useState("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useTickets({
    q: debouncedSearch || undefined,
    status: status === "all" ? undefined : status,
    priority: priority === "all" ? undefined : priority,
  });

  const tickets = useMemo(() => data?.data ?? [], [data]);

  // j/k keyboard nav
  const [focusedIdx, setFocusedIdx] = useState(-1);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA"
      )
        return;
      if (e.key === "j") {
        setFocusedIdx((i) => Math.min(i + 1, tickets.length - 1));
        e.preventDefault();
      } else if (e.key === "k") {
        setFocusedIdx((i) => Math.max(i - 1, 0));
        e.preventDefault();
      } else if (e.key === "Enter" && focusedIdx >= 0) {
        const t = tickets[focusedIdx];
        if (t) router.push(`/staff/tickets/${t.id}`);
      }
    },
    [tickets, focusedIdx, router]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <h1 className="mr-4 text-lg font-semibold">{t.nav.tickets}</h1>

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t.common.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
            aria-label="Поиск заявок"
          />
        </div>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Статус" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            <SelectItem value="open">Открытые</SelectItem>
            <SelectItem value="pending">Ожидают</SelectItem>
            <SelectItem value="in_progress">В работе</SelectItem>
            <SelectItem value="resolved">Решённые</SelectItem>
            <SelectItem value="closed">Закрытые</SelectItem>
          </SelectContent>
        </Select>

        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Приоритет" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все</SelectItem>
            <SelectItem value="urgent">Критический</SelectItem>
            <SelectItem value="high">Высокий</SelectItem>
            <SelectItem value="normal">Обычный</SelectItem>
            <SelectItem value="low">Низкий</SelectItem>
          </SelectContent>
        </Select>

        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/staff/kanban">
              <LayoutGrid className="mr-1.5 h-3.5 w-3.5" />
              Канбан
            </Link>
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="sr-only">Фильтры</span>
          </Button>
        </div>
      </div>

      {/* Results info */}
      <div className="px-6 py-2 text-xs text-muted-foreground border-b border-border">
        {isLoading
          ? "Загрузка..."
          : `${data?.total ?? 0} заявок · j/k для навигации · Enter для открытия`}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <TicketListSkeleton count={8} />
        ) : tickets.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <SlidersHorizontal className="h-8 w-8 opacity-30" />
            <p>{t.common.noResults}</p>
          </div>
        ) : (
          <div className="space-y-2" role="list" aria-label="Список заявок">
            {tickets.map((ticket, i) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                href={`/staff/tickets/${ticket.id}`}
                selected={i === focusedIdx}
                onSelect={() => setFocusedIdx(i)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
