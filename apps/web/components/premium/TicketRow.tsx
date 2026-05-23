'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { MessageSquare } from 'lucide-react';
import { cn, getInitials } from '@/lib/utils';
import { RelativeTime } from '@/components/RelativeTime';
import { StatusBadge } from './StatusBadge';
import { PriorityChip } from './PriorityChip';
import { SlaPill } from './SlaPill';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { Ticket } from '@/lib/types';

interface TicketRowProps {
  ticket: Ticket;
  href: string;
  selected?: boolean;
  onSelect?: () => void;
}

export function TicketRow({ ticket, href, selected, onSelect }: TicketRowProps) {
  return (
    <motion.div initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.2 }}>
      <Link
        href={href}
        onClick={onSelect}
        className={cn(
          'group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm transition-all',
          'hover:border-primary/30 hover:bg-primary/5 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          selected && 'border-primary/40 bg-primary/8',
        )}
        data-testid="ticket-row"
      >
        {/* Status dot */}
        <span
          className={cn(
            'h-2 w-2 flex-shrink-0 rounded-full',
            ticket.status === 'open' && 'bg-status-open',
            ticket.status === 'pending' && 'bg-status-pending',
            ticket.status === 'in_progress' && 'bg-status-progress',
            ticket.status === 'resolved' && 'bg-status-resolved',
            ticket.status === 'closed' && 'bg-status-closed',
          )}
          aria-hidden="true"
        />

        {/* Mask */}
        <span className="w-24 flex-shrink-0 font-mono text-xs text-muted-foreground">{ticket.mask}</span>

        {/* Subject */}
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium group-hover:text-primary">{ticket.subject}</p>
          {ticket.department && (
            <p className="truncate text-xs text-muted-foreground">{ticket.department.name}</p>
          )}
        </div>

        {/* Priority */}
        <div className="flex-shrink-0">
          <PriorityChip priority={ticket.priority} />
        </div>

        {/* Status badge */}
        <div className="hidden flex-shrink-0 sm:block">
          <StatusBadge status={ticket.status} size="sm" />
        </div>

        {/* SLA */}
        <div className="hidden flex-shrink-0 md:block">
          <SlaPill dueAt={ticket.sla_due_at} />
        </div>

        {/* Assignee avatar */}
        <div className="flex-shrink-0">
          {ticket.assignee ? (
            <Avatar className="h-6 w-6">
              <AvatarImage src={ticket.assignee.avatar_url} />
              <AvatarFallback className="text-[10px]">{getInitials(ticket.assignee.name)}</AvatarFallback>
            </Avatar>
          ) : (
            <div className="h-6 w-6 rounded-full border-2 border-dashed border-border" />
          )}
        </div>

        {/* Reply count + time */}
        <div className="hidden flex-shrink-0 items-center gap-1 text-xs text-muted-foreground lg:flex">
          <MessageSquare className="h-3.5 w-3.5" />
          {ticket.reply_count}
        </div>
        <RelativeTime
          date={ticket.updated_at}
          className="hidden flex-shrink-0 text-xs text-muted-foreground lg:block"
        />
      </Link>
    </motion.div>
  );
}
