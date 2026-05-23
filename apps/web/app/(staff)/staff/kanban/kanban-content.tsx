'use client';

import { useRouter } from 'next/navigation';
import { KanbanBoard } from '@/components/premium/KanbanBoard';
import { KanbanSkeleton } from '@/components/premium/SkeletonLoaders';
import { useTickets, useChangeTicketStatus } from '@/lib/hooks/use-tickets';
import { QueryError } from '@/components/QueryError';
import { toast } from '@/components/ui/use-toast';

export function KanbanPageContent() {
  const router = useRouter();
  const KANBAN_LIMIT = 50;
  const { data, isLoading, isError, refetch } = useTickets({ per_page: KANBAN_LIMIT });
  const changeStatus = useChangeTicketStatus();
  const tickets = data?.data ?? [];
  const total = data?.total ?? 0;
  const truncated = total > KANBAN_LIMIT;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-3">
        <h1 className="text-lg font-semibold">Канбан</h1>
        <p className="text-xs text-muted-foreground">Перетаскивайте карточки для смены статуса</p>
      </div>
      {truncated && (
        <div className="border-b border-sla-warn/30 bg-sla-warn/10 px-6 py-2 text-xs text-sla-warn">
          Показаны первые {KANBAN_LIMIT} из {total} заявок. Используйте список с фильтрами, чтобы увидеть
          остальные.
        </div>
      )}
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <KanbanSkeleton />
        ) : isError ? (
          <QueryError message="Не удалось загрузить канбан-доску." onRetry={() => void refetch()} />
        ) : (
          <KanbanBoard
            tickets={tickets}
            onOpen={(id) => router.push(`/staff/tickets/${id}`)}
            onMove={(ticketId, status) =>
              changeStatus.mutate(
                { ticketId, status },
                {
                  onSuccess: () => toast({ title: 'Статус обновлён' }),
                  onError: () =>
                    toast({
                      title: 'Ошибка',
                      description: 'Не удалось сменить статус',
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
