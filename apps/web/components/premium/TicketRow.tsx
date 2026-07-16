'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { MessageSquare, Tag, Building2 } from 'lucide-react';
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
        {/* ── LEFT: categorization — Status, Priority, Type (intrinsic width, so the
             subject gets the remaining space) ── */}
        <div className="flex-shrink-0">
          <StatusBadge status={ticket.status} size="sm" />
        </div>

        {/* Priority */}
        <div className="flex-shrink-0">
          <PriorityChip priority={ticket.priority} />
        </div>

        {/* Type */}
        <div className="hidden flex-shrink-0 sm:block">
          {ticket.typeName ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
              <Tag className="h-3 w-3 flex-shrink-0" />
              <span className="whitespace-nowrap">{ticket.typeName}</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/50">—</span>
          )}
        </div>

        {/* Mask */}
        <span className="hidden w-20 flex-shrink-0 font-mono text-xs text-muted-foreground sm:inline">
          {ticket.mask}
        </span>

        {/* Subject (+ tags) — takes all remaining space */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate font-medium group-hover:text-primary">{ticket.subject}</p>
            {ticket.tags?.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="hidden flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground lg:inline"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>

        {/* SLA */}
        <div className="hidden flex-shrink-0 md:block">
          <SlaPill dueAt={ticket.sla_due_at} />
        </div>

        {/* ── RIGHT: who & where — Organization, then Owner ── */}
        {/* Organization that submitted the ticket */}
        <div className="hidden w-36 flex-shrink-0 items-center gap-1 text-xs text-muted-foreground md:flex">
          <Building2 className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
          <span className="truncate">{ticket.organization?.name ?? '—'}</span>
        </div>

        {/* Owner (assignee) — avatar + name */}
        <div className="flex w-40 flex-shrink-0 items-center gap-2">
          {ticket.assignee ? (
            <>
              <Avatar className="h-6 w-6 flex-shrink-0">
                <AvatarImage src={ticket.assignee.avatar_url} />
                <AvatarFallback className="text-[10px]">{getInitials(ticket.assignee.name)}</AvatarFallback>
              </Avatar>
              <span className="hidden truncate text-xs text-foreground/80 lg:inline">
                {ticket.assignee.name}
              </span>
            </>
          ) : (
            <>
              <div className="h-6 w-6 flex-shrink-0 rounded-full border-2 border-dashed border-border" />
              <span className="hidden truncate text-xs text-muted-foreground/60 lg:inline">Не назначен</span>
            </>
          )}
        </div>

        {/* Reply count + time */}
        <div className="hidden flex-shrink-0 items-center gap-1 text-xs text-muted-foreground xl:flex">
          <MessageSquare className="h-3.5 w-3.5" />
          {ticket.reply_count}
        </div>
        <RelativeTime
          date={ticket.updated_at}
          className="hidden flex-shrink-0 text-xs text-muted-foreground xl:block"
        />
      </Link>
    </motion.div>
  );
}
