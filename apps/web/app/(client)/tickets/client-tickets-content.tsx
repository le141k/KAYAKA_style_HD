'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TicketRow } from '@/components/premium/TicketRow';
import { TicketListSkeleton } from '@/components/premium/SkeletonLoaders';
import { useClientTickets } from '@/lib/hooks/use-client-tickets';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QueryError } from '@/components/QueryError';

/**
 * Renders the client "Мои заявки" list.
 *
 * CL-3 affordance: if no client_email is stored in localStorage (so the list
 * would always be empty), show a small form that lets the user enter their
 * email to look up their tickets — without requiring a staff login.
 */
export function ClientTicketsContent() {
  const { data, isLoading, isError, refetch } = useClientTickets();
  const tickets = data?.data ?? [];

  // Local state for the email-lookup affordance
  const [inputEmail, setInputEmail] = useState('');
  const [showLookup, setShowLookup] = useState(() => {
    if (typeof window === 'undefined') return false;
    return !localStorage.getItem('client_email');
  });

  const handleLookup = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputEmail.trim();
    if (!trimmed) return;
    localStorage.setItem('client_email', trimmed);
    setShowLookup(false);
    void refetch();
  };

  if (isLoading) return <TicketListSkeleton count={5} />;
  if (isError)
    return <QueryError message="Не удалось загрузить ваши обращения." onRetry={() => void refetch()} />;

  // Show email-lookup form when no email is stored yet
  if (showLookup) {
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="text-sm font-medium">Посмотреть свои обращения по email</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Введите email, который вы указывали при создании обращения.
        </p>
        <form onSubmit={handleLookup} className="mx-auto mt-4 flex max-w-sm gap-2">
          <Input
            type="email"
            placeholder="ivan@example.com"
            value={inputEmail}
            onChange={(e) => setInputEmail(e.target.value)}
            required
          />
          <Button type="submit">Найти</Button>
        </form>
        <div className="mt-6">
          <Button asChild variant="outline" size="sm">
            <Link href="/submit">Создать обращение</Link>
          </Button>
        </div>
      </div>
    );
  }

  if (tickets.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border p-12 text-center">
        <p className="text-muted-foreground">У вас пока нет обращений</p>
        <Button asChild className="mt-4">
          <Link href="/submit">Создать первое обращение</Link>
        </Button>
        <div className="mt-3">
          <button
            type="button"
            className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => {
              localStorage.removeItem('client_email');
              setShowLookup(true);
              setInputEmail('');
            }}
          >
            Искать по другому email
          </button>
        </div>
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
