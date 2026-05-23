'use client';

import { useRouter } from 'next/navigation';
import { KanbanBoard } from '@/components/premium/KanbanBoard';
import { KanbanSkeleton } from '@/components/premium/SkeletonLoaders';
import { useTickets, useChangeTicketStatus } from '@/lib/hooks/use-tickets';
import { toast } from '@/components/ui/use-toast';

export function KanbanPageContent() {
  const router = useRouter();
  const { data, isLoading } = useTickets({ per_page: 50 });
  const changeStatus = useChangeTicketStatus();
  const tickets = data?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border bg-card px-6 py-3">
        <h1 className="text-lg font-semibold">Канбан</h1>
        <p className="text-xs text-muted-foreground">Перетаскивайте карточки для смены статуса</p>
      </div>
      <div className="flex-1 overflow-auto p-6">
        {isLoading ? (
          <KanbanSkeleton />
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
