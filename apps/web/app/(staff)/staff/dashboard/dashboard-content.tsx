'use client';

import Link from 'next/link';
import { Ticket, Clock, CheckCircle2, AlertTriangle, Timer } from 'lucide-react';
import { AnimatedStatCard } from '@/components/premium/AnimatedStatCard';
import { QueryError } from '@/components/QueryError';
import { TicketRow } from '@/components/premium/TicketRow';
import { DashboardStatsSkeleton, TicketListSkeleton } from '@/components/premium/SkeletonLoaders';
import { useDashboardStats, useTickets } from '@/lib/hooks/use-tickets';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

export function DashboardContent() {
  const { t } = useI18n();
  const { data: stats, isLoading: statsLoading, isError: statsError, refetch } = useDashboardStats();
  const { data: tickets, isLoading: ticketsLoading } = useTickets({
    per_page: 5,
  });

  const recentTickets = tickets?.data ?? [];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t.dashboard.title}</h1>
          <p className="text-sm text-muted-foreground">Добро пожаловать в 23T Help Desk</p>
        </div>
        <Button asChild>
          <Link href="/staff/tickets?create=1">{t.nav.newTicket}</Link>
        </Button>
      </div>

      {/* Stats */}
      {statsError ? (
        <QueryError message="Не удалось загрузить метрики дашборда." onRetry={() => void refetch()} />
      ) : statsLoading || !stats ? (
        <DashboardStatsSkeleton />
      ) : (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-5">
          <Link href="/staff/tickets?status=open" className="block">
            <AnimatedStatCard
              title={t.dashboard.openTickets}
              value={stats.open_tickets}
              icon={Ticket}
              colorClass="brand"
            />
          </Link>
          <Link href="/staff/tickets?status=pending" className="block">
            <AnimatedStatCard
              title={t.dashboard.pendingTickets}
              value={stats.pending_tickets}
              icon={Clock}
              colorClass="amber"
            />
          </Link>
          <AnimatedStatCard
            title={t.dashboard.resolvedToday}
            value={stats.resolved_today}
            icon={CheckCircle2}
            colorClass="green"
          />
          <Link href="/staff/tickets?status=open&sla_breached=1" className="block">
            <AnimatedStatCard
              title={t.dashboard.slaBreached}
              value={stats.sla_breached}
              icon={AlertTriangle}
              colorClass="red"
            />
          </Link>
          <AnimatedStatCard
            title={t.dashboard.avgResponse}
            value={stats.avg_first_response_minutes}
            suffix={t.dashboard.minutes}
            icon={Timer}
            colorClass="indigo"
            className="col-span-2 lg:col-span-1"
          />
        </div>
      )}

      {/* Recent tickets */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{t.dashboard.recentTickets}</h2>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/staff/tickets">Все заявки →</Link>
          </Button>
        </div>

        {ticketsLoading ? (
          <TicketListSkeleton count={5} />
        ) : recentTickets.length === 0 ? (
          <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
            Нет заявок
          </div>
        ) : (
          <div className="space-y-2">
            {recentTickets.map((ticket) => (
              <TicketRow key={ticket.id} ticket={ticket} href={`/staff/tickets/${ticket.id}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
