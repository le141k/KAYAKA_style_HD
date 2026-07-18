'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Mail, Loader2, CheckCircle2, LogOut } from 'lucide-react';
import { TicketRow } from '@/components/premium/TicketRow';
import { TicketListSkeleton } from '@/components/premium/SkeletonLoaders';
import { useClientTickets } from '@/lib/hooks/use-client-tickets';
import {
  clientAuthKeys,
  useClientSession,
  useRequestClientLink,
  useClientLogout,
} from '@/lib/hooks/use-client-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QueryError } from '@/components/QueryError';
import { TurnstileWidget, type TurnstileWidgetHandle } from '@/components/security/TurnstileWidget';

/**
 * Client "Мои заявки" list (GOAL_PUBLIC_SECURITY S2-9).
 *
 * Ownership is a verified magic-link session (`th_client` cookie), NOT a self-typed email.
 * Signed out → request a sign-in link; signed in → the user's own tickets + sign out. The old
 * "enter any email to see tickets" lookup (an IDOR) is gone.
 */
export function ClientTicketsContent() {
  const { data: session, isLoading, isError, refetch } = useClientSession();

  if (isLoading) return <TicketListSkeleton count={5} />;
  if (isError) return <QueryError message="Не удалось проверить сессию." onRetry={() => void refetch()} />;

  if (!session) return <SignInPanel />;
  return <SignedInTickets />;
}

/** Request-a-link sign-in panel. Always shows the same confirmation — no email enumeration. */
function SignInPanel() {
  const [email, setEmail] = useState('');
  const [challengeToken, setChallengeToken] = useState<string>();
  const challengeRef = useRef<TurnstileWidgetHandle>(null);
  const requestLink = useRequestClientLink();
  const sent = requestLink.isSuccess;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (trimmed && challengeToken) {
      requestLink.mutate(
        { email: trimmed, challengeToken },
        { onSettled: () => challengeRef.current?.reset() },
      );
    }
  };

  if (sent) {
    return (
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-8 text-center">
        <CheckCircle2 className="mx-auto mb-3 h-8 w-8 text-primary" />
        <p className="text-sm font-medium">Проверьте почту</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
          Если на этот адрес зарегистрированы обращения, мы отправили ссылку для входа. Она действует
          15&nbsp;минут.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-border p-8 text-center">
      <Mail className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium">Войдите, чтобы увидеть свои обращения</p>
      <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
        Введите email, указанный в ваших обращениях — мы пришлём ссылку для входа.
      </p>
      <form onSubmit={onSubmit} className="mx-auto mt-4 max-w-sm space-y-3">
        <div className="flex gap-2">
          <Input
            type="email"
            placeholder="ivan@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={requestLink.isPending}
          />
          <Button type="submit" disabled={requestLink.isPending || !challengeToken}>
            {requestLink.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Получить ссылку'}
          </Button>
        </div>
        <TurnstileWidget ref={challengeRef} action="request-link" onToken={setChallengeToken} />
      </form>
      {requestLink.isError && (
        <p className="mt-2 text-xs text-destructive">Не удалось отправить ссылку. Попробуйте ещё раз.</p>
      )}
      <div className="mt-6">
        <Button asChild variant="outline" size="sm">
          <Link href="/submit">Создать обращение</Link>
        </Button>
      </div>
    </div>
  );
}

/** The signed-in client's own ticket list + sign-out. */
function SignedInTickets() {
  const qc = useQueryClient();
  const { data, isLoading, isError, error, refetch } = useClientTickets();
  const logout = useClientLogout();
  const tickets = data?.data ?? [];

  const signOut = () => logout.mutate();

  // If the list 401s (the session was revoked out-of-band while the session query was still
  // fresh), re-check the session so the page falls back to the sign-in panel instead of a retry.
  const listStatus = (error as { status?: number } | null)?.status;
  useEffect(() => {
    if (isError && listStatus === 401) {
      void qc.invalidateQueries({ queryKey: clientAuthKeys.session });
    }
  }, [isError, listStatus, qc]);

  if (isLoading) return <TicketListSkeleton count={5} />;
  if (isError && listStatus === 401) return <TicketListSkeleton count={5} />; // re-checking session
  if (isError)
    return <QueryError message="Не удалось загрузить ваши обращения." onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={signOut}
          disabled={logout.isPending}
          className="text-muted-foreground"
        >
          <LogOut className="mr-1.5 h-4 w-4" />
          Выйти
        </Button>
      </div>

      {tickets.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <p className="text-muted-foreground">У вас пока нет обращений</p>
          <Button asChild className="mt-4">
            <Link href="/submit">Создать первое обращение</Link>
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {tickets.map((ticket) => (
            <TicketRow key={ticket.id} ticket={ticket} href={`/tickets/${ticket.id}`} />
          ))}
        </div>
      )}
    </div>
  );
}
