"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  Ticket,
  Reply,
  PaginatedResponse,
  DashboardStats,
} from "@/lib/types";
import {
  MOCK_TICKETS,
  MOCK_REPLIES,
  MOCK_STATS,
} from "@/lib/mock-data";

// ─── Query Keys ───────────────────────────────────────────────────────────────
export const ticketKeys = {
  all: ["tickets"] as const,
  lists: () => [...ticketKeys.all, "list"] as const,
  list: (params: Record<string, unknown>) =>
    [...ticketKeys.lists(), params] as const,
  detail: (id: number) => [...ticketKeys.all, "detail", id] as const,
  replies: (id: number) => [...ticketKeys.all, id, "replies"] as const,
  stats: ["dashboard-stats"] as const,
};

// ─── Tickets List ─────────────────────────────────────────────────────────────
export interface TicketListParams {
  page?: number;
  per_page?: number;
  status?: string;
  priority?: string;
  department_id?: number;
  assignee_id?: number;
  q?: string;
}

export function useTickets(params: TicketListParams = {}) {
  return useQuery({
    queryKey: ticketKeys.list(params as Record<string, unknown>),
    queryFn: async () => {
      try {
        const qs = new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => [k, String(v)])
        ).toString();
        return await api.get<PaginatedResponse<Ticket>>(
          `/tickets${qs ? `?${qs}` : ""}`
        );
      } catch {
        // fallback mock
        let data = [...MOCK_TICKETS];
        if (params.status) data = data.filter((t) => t.status === params.status);
        if (params.q) {
          const q = params.q.toLowerCase();
          data = data.filter(
            (t) =>
              t.subject.toLowerCase().includes(q) ||
              t.mask.toLowerCase().includes(q)
          );
        }
        return {
          data,
          total: data.length,
          page: params.page ?? 1,
          per_page: params.per_page ?? 25,
        } satisfies PaginatedResponse<Ticket>;
      }
    },
    staleTime: 30_000,
  });
}

// ─── Single Ticket ────────────────────────────────────────────────────────────
export function useTicket(id: number) {
  return useQuery({
    queryKey: ticketKeys.detail(id),
    queryFn: async () => {
      try {
        return await api.get<Ticket>(`/tickets/${id}`);
      } catch {
        return MOCK_TICKETS.find((t) => t.id === id) ?? null;
      }
    },
    enabled: id > 0,
  });
}

// ─── Replies ─────────────────────────────────────────────────────────────────
export function useReplies(ticketId: number) {
  return useQuery({
    queryKey: ticketKeys.replies(ticketId),
    queryFn: async () => {
      try {
        return await api.get<Reply[]>(`/tickets/${ticketId}/replies`);
      } catch {
        return MOCK_REPLIES.filter((r) => r.ticket_id === ticketId);
      }
    },
    enabled: ticketId > 0,
  });
}

// ─── Create Ticket ────────────────────────────────────────────────────────────
export interface CreateTicketInput {
  subject: string;
  body: string;
  priority?: string;
  department_id?: number;
  attachments?: File[];
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTicketInput) =>
      api.post<Ticket>("/tickets", data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Public (unauthenticated) submission from the client portal → POST /tickets/public.
export interface PublicTicketInput {
  subject: string;
  contents: string;
  requesterEmail: string;
  requesterName?: string;
  departmentId?: number;
}

export function useSubmitPublicTicket() {
  return useMutation({
    mutationFn: (data: PublicTicketInput) =>
      api.post<Ticket>("/tickets/public", data),
  });
}

// ─── Reply ────────────────────────────────────────────────────────────────────
export interface CreateReplyInput {
  body: string;
  is_internal?: boolean;
  attachments?: File[];
}

export function useReply(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateReplyInput) =>
      api.post<Reply>(`/tickets/${ticketId}/reply`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.replies(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

// ─── Update Ticket ────────────────────────────────────────────────────────────
export function useUpdateTicket(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Ticket>) =>
      api.patch<Ticket>(`/tickets/${ticketId}`, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// ─── Dashboard Stats ──────────────────────────────────────────────────────────
export function useDashboardStats() {
  return useQuery({
    queryKey: ticketKeys.stats,
    queryFn: async () => {
      try {
        return await api.get<DashboardStats>("/dashboard/stats");
      } catch {
        return MOCK_STATS;
      }
    },
    staleTime: 60_000,
  });
}
