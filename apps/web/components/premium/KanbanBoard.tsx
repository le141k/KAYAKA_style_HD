'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { cn, getInitials } from '@/lib/utils';
import { StatusBadge } from './StatusBadge';
import { PriorityChip } from './PriorityChip';
import { SlaPill } from './SlaPill';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import type { Ticket, TicketStatus } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

// NOTE: column ids and order are fixed; labels come from i18n so they are
// locale-aware rather than hardcoded Russian strings.
const COLUMN_IDS: TicketStatus[] = ['open', 'in_progress', 'pending', 'resolved', 'closed'];

interface KanbanCardProps {
  ticket: Ticket;
  onOpen: (id: number) => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
}

function KanbanCard({ ticket, onOpen, onDragStart, onDragEnd }: KanbanCardProps) {
  return (
    <motion.div
      layout
      draggable
      onDragStart={() => onDragStart(ticket.id)}
      onDragEnd={onDragEnd}
      className={cn(
        'group cursor-grab rounded-lg border border-border bg-card p-3 shadow-sm active:cursor-grabbing',
        'transition-all hover:border-primary/30 hover:shadow-md',
      )}
      onClick={() => onOpen(ticket.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(ticket.id)}
      aria-label={`Открыть заявку ${ticket.mask}`}
      data-testid="kanban-card"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">{ticket.mask}</span>
        <PriorityChip priority={ticket.priority} />
      </div>
      <p className="mb-2 line-clamp-2 text-sm font-medium leading-snug">{ticket.subject}</p>
      <div className="flex items-center justify-between">
        <SlaPill dueAt={ticket.sla_due_at} />
        {ticket.assignee && (
          <Avatar className="h-5 w-5">
            <AvatarImage src={ticket.assignee.avatar_url} />
            <AvatarFallback className="text-[8px]">{getInitials(ticket.assignee.name)}</AvatarFallback>
          </Avatar>
        )}
      </div>
    </motion.div>
  );
}

interface KanbanColumnProps {
  id: TicketStatus;
  label: string;
  tickets: Ticket[];
  onOpen: (id: number) => void;
  onDragStart: (id: number) => void;
  onDragEnd: () => void;
  onDropTo: (status: TicketStatus) => void;
  isDropTarget: boolean;
  setDropTarget: (status: TicketStatus | null) => void;
}

const countClass: Record<TicketStatus, string> = {
  open: 'bg-status-open/10 text-status-open',
  in_progress: 'bg-status-progress/10 text-status-progress',
  pending: 'bg-status-pending/10 text-status-pending',
  resolved: 'bg-status-resolved/10 text-status-resolved',
  closed: 'bg-status-closed/10 text-status-closed',
};

function KanbanColumn({
  id,
  label,
  tickets,
  onOpen,
  onDragStart,
  onDragEnd,
  onDropTo,
  isDropTarget,
  setDropTarget,
}: KanbanColumnProps) {
  return (
    <div
      className={cn(
        'flex min-h-[400px] w-72 flex-shrink-0 flex-col rounded-xl border bg-muted/40 transition-colors',
        isDropTarget ? 'border-primary ring-2 ring-primary/40' : 'border-border',
      )}
      onDragOver={(e) => {
        e.preventDefault();
        setDropTarget(id);
      }}
      onDragLeave={() => setDropTarget(null)}
      onDrop={(e) => {
        e.preventDefault();
        onDropTo(id);
        setDropTarget(null);
      }}
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={id} size="sm" />
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <span className={cn('rounded-full px-2 py-0.5 text-xs font-bold', countClass[id])}>
          {tickets.length}
        </span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3" aria-label={`Колонка ${label}`}>
        {tickets.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-border text-xs text-muted-foreground">
            Перетащите сюда
          </div>
        ) : (
          tickets.map((ticket) => (
            <KanbanCard
              key={ticket.id}
              ticket={ticket}
              onOpen={onOpen}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}

export interface KanbanFilters {
  status?: TicketStatus | '';
  priority?: Ticket['priority'] | '';
  assigneeId?: string;
  q?: string;
}

interface KanbanBoardProps {
  tickets: Ticket[];
  onOpen: (id: number) => void;
  /** Persist a cross-column move (drag → drop) to the backend. */
  onMove?: (ticketId: number, status: TicketStatus) => void;
  /** Active filter values (controlled externally). */
  filters?: KanbanFilters;
}

function group(tickets: Ticket[]): Record<TicketStatus, Ticket[]> {
  return {
    open: tickets.filter((t) => t.status === 'open'),
    in_progress: tickets.filter((t) => t.status === 'in_progress'),
    pending: tickets.filter((t) => t.status === 'pending'),
    resolved: tickets.filter((t) => t.status === 'resolved'),
    closed: tickets.filter((t) => t.status === 'closed'),
  };
}

function applyFilters(tickets: Ticket[], filters: KanbanFilters): Ticket[] {
  return tickets.filter((t) => {
    if (filters.status && t.status !== filters.status) return false;
    if (filters.priority && t.priority !== filters.priority) return false;
    if (filters.assigneeId && String(t.assignee?.id ?? '') !== filters.assigneeId) return false;
    if (filters.q) {
      const q = filters.q.toLowerCase();
      if (!t.subject.toLowerCase().includes(q) && !t.mask.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

export function KanbanBoard({ tickets, onOpen, onMove, filters = {} }: KanbanBoardProps) {
  const { t } = useI18n();
  const cols = t.kanban.columns;

  const COLUMNS: { id: TicketStatus; label: string }[] = [
    { id: 'open', label: cols.open },
    { id: 'in_progress', label: cols.in_progress },
    { id: 'pending', label: cols.pending },
    { id: 'resolved', label: cols.resolved },
    { id: 'closed', label: cols.closed },
  ];

  const filtered = applyFilters(tickets, filters);
  const [columnTickets, setColumnTickets] = useState<Record<TicketStatus, Ticket[]>>(() => group(filtered));
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<TicketStatus | null>(null);

  // Re-sync when the upstream ticket list or filters change (refetch after a move).
  // Depend on the primitive filter fields (not the object identity) to avoid
  // resetting local column state on every parent re-render.
  const filterKey = `${filters.status ?? ''}|${filters.priority ?? ''}|${filters.assigneeId ?? ''}|${filters.q ?? ''}`;
  useEffect(() => {
    setColumnTickets(group(applyFilters(tickets, filters)));
  }, [tickets, filterKey]);

  const handleDragEnd = () => {
    // Clear dragging state when the user drops outside any valid column —
    // prevents phantom "still dragging" state after off-target drops.
    setDraggingId(null);
  };

  const handleDropTo = (status: TicketStatus) => {
    if (draggingId == null) return;
    const card = tickets.find((t) => t.id === draggingId);
    setDraggingId(null);
    if (!card || card.status === status) return;
    // Optimistic local move
    setColumnTickets((prev) => {
      const next = { ...prev };
      for (const col of COLUMN_IDS) {
        next[col] = next[col].filter((t) => t.id !== card.id);
      }
      next[status] = [{ ...card, status }, ...next[status]];
      return next;
    });
    onMove?.(card.id, status);
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map((col) => (
        <KanbanColumn
          key={col.id}
          id={col.id}
          label={col.label}
          tickets={columnTickets[col.id] ?? []}
          onOpen={onOpen}
          onDragStart={setDraggingId}
          onDragEnd={handleDragEnd}
          onDropTo={handleDropTo}
          isDropTarget={dropTarget === col.id}
          setDropTarget={setDropTarget}
        />
      ))}
    </div>
  );
}
