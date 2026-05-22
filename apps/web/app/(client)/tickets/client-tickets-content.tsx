'use client';

import Link from 'next/link';
import { TicketRow } from '@/components/premium/TicketRow';
import { TicketListSkeleton } from '@/components/premium/SkeletonLoaders';
import { useClientTickets } from '@/lib/hooks/use-client-tickets';
import { Button } from '@/components/ui/button';

export function ClientTicketsContent() {
  const { data, isLoading } = useClientTickets();
  const tickets = data?.data ?? [];

  if (isLoading) return <TicketListSkeleton count={5} />;

  if (tickets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-12 text-center">
        <p className="text-muted-foreground">У вас пока нет обращений</p>
        <Button asChild className="mt-4">
          <Link href="/submit">Создать первое обращение</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {tickets.map((ticket) => (
        <TicketRow key={ticket.id} ticket={ticket} href={`/tickets/${ticket.id}`} />
      ))}
    </div>
  );
}
