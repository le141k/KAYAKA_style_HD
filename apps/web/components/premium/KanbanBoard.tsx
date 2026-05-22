"use client";

import { useState } from "react";
import { motion, Reorder } from "framer-motion";
import { cn, getInitials } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import { PriorityChip } from "./PriorityChip";
import { SlaPill } from "./SlaPill";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Ticket, TicketStatus } from "@/lib/types";

const COLUMNS: { id: TicketStatus; label: string }[] = [
  { id: "open", label: "Открытые" },
  { id: "in_progress", label: "В работе" },
  { id: "pending", label: "Ожидают" },
  { id: "resolved", label: "Решённые" },
];

interface KanbanCardProps {
  ticket: Ticket;
  onOpen: (id: number) => void;
}

function KanbanCard({ ticket, onOpen }: KanbanCardProps) {
  return (
    <Reorder.Item
      value={ticket}
      id={String(ticket.id)}
      className="cursor-grab active:cursor-grabbing"
      whileDrag={{
        scale: 1.03,
        boxShadow: "0 8px 32px hsl(var(--primary) / 0.35)",
        zIndex: 50,
      }}
      data-testid="kanban-card"
    >
      <motion.div
        layout
        className={cn(
          "group rounded-lg border border-border bg-card p-3 shadow-sm",
          "hover:border-primary/30 hover:shadow-md transition-all"
        )}
        onClick={() => onOpen(ticket.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && onOpen(ticket.id)}
        aria-label={`Открыть заявку ${ticket.mask}`}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] text-muted-foreground">
            {ticket.mask}
          </span>
          <PriorityChip priority={ticket.priority} />
        </div>

        <p className="mb-2 line-clamp-2 text-sm font-medium leading-snug">
          {ticket.subject}
        </p>

        <div className="flex items-center justify-between">
          <SlaPill dueAt={ticket.sla_due_at} />
          {ticket.assignee && (
            <Avatar className="h-5 w-5">
              <AvatarImage src={ticket.assignee.avatar_url} />
              <AvatarFallback className="text-[8px]">
                {getInitials(ticket.assignee.name)}
              </AvatarFallback>
            </Avatar>
          )}
        </div>
      </motion.div>
    </Reorder.Item>
  );
}

interface KanbanColumnProps {
  id: TicketStatus;
  label: string;
  tickets: Ticket[];
  onReorder: (tickets: Ticket[]) => void;
  onOpen: (id: number) => void;
}

function KanbanColumn({
  id,
  label,
  tickets,
  onReorder,
  onOpen,
}: KanbanColumnProps) {
  const countClass: Record<TicketStatus, string> = {
    open: "bg-status-open/10 text-status-open",
    in_progress: "bg-status-progress/10 text-status-progress",
    pending: "bg-status-pending/10 text-status-pending",
    resolved: "bg-status-resolved/10 text-status-resolved",
    closed: "bg-status-closed/10 text-status-closed",
  };

  return (
    <div className="flex min-h-[400px] w-72 flex-shrink-0 flex-col rounded-xl border border-border bg-muted/40">
      {/* Column header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={id} size="sm" />
          <span className="text-sm font-semibold">{label}</span>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-xs font-bold",
            countClass[id]
          )}
        >
          {tickets.length}
        </span>
      </div>

      {/* Cards */}
      <Reorder.Group
        axis="y"
        values={tickets}
        onReorder={onReorder}
        className="flex-1 space-y-2 overflow-y-auto p-3"
        aria-label={`Колонка ${label}`}
      >
        {tickets.length === 0 ? (
          <div className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-border text-xs text-muted-foreground">
            Нет заявок
          </div>
        ) : (
          tickets.map((ticket) => (
            <KanbanCard key={ticket.id} ticket={ticket} onOpen={onOpen} />
          ))
        )}
      </Reorder.Group>
    </div>
  );
}

interface KanbanBoardProps {
  tickets: Ticket[];
  onOpen: (id: number) => void;
}

export function KanbanBoard({ tickets, onOpen }: KanbanBoardProps) {
  const [columnTickets, setColumnTickets] = useState<
    Record<TicketStatus, Ticket[]>
  >({
    open: tickets.filter((t) => t.status === "open"),
    in_progress: tickets.filter((t) => t.status === "in_progress"),
    pending: tickets.filter((t) => t.status === "pending"),
    resolved: tickets.filter((t) => t.status === "resolved"),
    closed: tickets.filter((t) => t.status === "closed"),
  });

  const handleReorder = (colId: TicketStatus) => (newOrder: Ticket[]) => {
    setColumnTickets((prev) => ({ ...prev, [colId]: newOrder }));
  };

  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {COLUMNS.map((col) => (
        <KanbanColumn
          key={col.id}
          id={col.id}
          label={col.label}
          tickets={columnTickets[col.id] ?? []}
          onReorder={handleReorder(col.id)}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
