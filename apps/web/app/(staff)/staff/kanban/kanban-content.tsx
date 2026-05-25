'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { KanbanBoard, type KanbanFilters } from '@/components/premium/KanbanBoard';
import { KanbanSkeleton } from '@/components/premium/SkeletonLoaders';
import { useTickets, useChangeTicketStatus, useStaffOptions } from '@/lib/hooks/use-tickets';
import { QueryError } from '@/components/QueryError';
import { toast } from '@/components/ui/use-toast';
import { useI18n } from '@/lib/i18n';
import type { Ticket, TicketStatus } from '@/lib/types';

const PRIORITY_VALUES: Ticket['priority'][] = ['urgent', 'high', 'normal', 'low'];
const STATUS_VALUES: TicketStatus[] = ['open', 'in_progress', 'pending', 'resolved', 'closed'];

export function KanbanPageContent() {
  const router = useRouter();
  const { t } = useI18n();
  const k = t.kanbanPage;
  const kf = t.kanban.filters;
  const kc = t.kanban.columns;

  const KANBAN_LIMIT = 100;

  // Filters state
  const [filters, setFilters] = useState<KanbanFilters>({});

  const { data, isLoading, isError, refetch } = useTickets({ per_page: KANBAN_LIMIT });
  const changeStatus = useChangeTicketStatus();
  const { data: staffOptions = [] } = useStaffOptions();
  const tickets = data?.data ?? [];
  const total = data?.total ?? 0;
  const truncated = total > KANBAN_LIMIT;

  const statusLabels: Record<TicketStatus, string> = {
    open: kc.open,
    in_progress: kc.in_progress,
    pending: kc.pending,
    resolved: kc.resolved,
    closed: kc.closed,
  };

  const hasFilters = !!(filters.status || filters.priority || filters.assigneeId || filters.q);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-3">
        <h1 className="text-lg font-semibold">{k.title}</h1>
        <p className="text-xs text-muted-foreground">{k.subtitle}</p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card/60 px-6 py-2">
        {/* Status filter */}
        <select
          value={filters.status ?? ''}
          onChange={(e) =>
            setFilters((f) => ({ ...f, status: (e.target.value as TicketStatus) || undefined }))
          }
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          aria-label={kf.status}
        >
          <option value="">
            {kf.status}: {kf.all}
          </option>
          {STATUS_VALUES.map((s) => (
            <option key={s} value={s}>
              {statusLabels[s]}
            </option>
          ))}
        </select>

        {/* Priority filter */}
        <select
          value={filters.priority ?? ''}
          onChange={(e) =>
            setFilters((f) => ({ ...f, priority: (e.target.value as Ticket['priority']) || undefined }))
          }
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          aria-label={kf.priority}
        >
          <option value="">
            {kf.priority}: {kf.all}
          </option>
          {PRIORITY_VALUES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>

        {/* Assignee filter */}
        <select
          value={filters.assigneeId ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, assigneeId: e.target.value || undefined }))}
          className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          aria-label={kf.assignee}
        >
          <option value="">
            {kf.assignee}: {kf.all}
          </option>
          {staffOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* Search */}
        <input
          type="search"
          value={filters.q ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value || undefined }))}
          placeholder={kf.searchPlaceholder}
          className="h-8 flex-1 min-w-[160px] rounded-md border border-input bg-transparent px-3 text-xs"
          aria-label={kf.search}
        />

        {hasFilters && (
          <button
            type="button"
            onClick={() => setFilters({})}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            {kf.reset}
          </button>
        )}
      </div>

      {truncated && (
        <div className="border-b border-sla-warn/30 bg-sla-warn/10 px-6 py-2 text-xs text-sla-warn">
          {k.cap.replace('{shown}', String(KANBAN_LIMIT)).replace('{total}', String(total))}
        </div>
      )}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <KanbanSkeleton />
        ) : isError ? (
          <QueryError message={k.loadError} onRetry={() => void refetch()} />
        ) : (
          <KanbanBoard
            tickets={tickets}
            onOpen={(id) => router.push(`/staff/tickets/${id}`)}
            filters={filters}
            onMove={(ticketId, status) =>
              changeStatus.mutate(
                { ticketId, status },
                {
                  onSuccess: () => toast({ title: k.statusUpdated }),
                  onError: () =>
                    toast({
                      title: k.errorTitle,
                      description: k.statusError,
                      variant: 'destructive',
                    }),
                },
              )
            }
          />
        )}
      </div>
    </div>
  );
}
