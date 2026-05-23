'use client';

import { useRouter } from 'next/navigation';
import { KanbanBoard } from '@/components/premium/KanbanBoard';
import { KanbanSkeleton } from '@/components/premium/SkeletonLoaders';
import { useTickets, useChangeTicketStatus } from '@/lib/hooks/use-tickets';
import { QueryError } from '@/components/QueryError';
import { toast } from '@/components/ui/use-toast';
import { useI18n } from '@/lib/i18n';

export function KanbanPageContent() {
  const router = useRouter();
  const { t } = useI18n();
  const k = t.kanbanPage;
  const KANBAN_LIMIT = 50;
  const { data, isLoading, isError, refetch } = useTickets({ per_page: KANBAN_LIMIT });
  const changeStatus = useChangeTicketStatus();
  const tickets = data?.data ?? [];
  const total = data?.total ?? 0;
  const truncated = total > KANBAN_LIMIT;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-3">
        <h1 className="text-lg font-semibold">{k.title}</h1>
        <p className="text-xs text-muted-foreground">{k.subtitle}</p>
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
