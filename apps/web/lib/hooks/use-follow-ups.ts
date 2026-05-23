'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── API shapes (backend) ────────────────────────────────────────────────────
export interface FollowUp {
  id: number;
  ticketId: number;
  staffId: number;
  dueAt: string;
  note: string | null;
  completed: boolean;
  completedAt: string | null;
  createdAt: string;
  staff?: { firstName: string; lastName: string } | null;
}

export const followUpKeys = {
  all: ['follow-ups'] as const,
  list: (ticketId: number) => [...followUpKeys.all, 'list', ticketId] as const,
};

/** List follow-ups for a ticket (ordered by due date asc, server-side). */
export function useFollowUps(ticketId: number) {
  return useQuery({
    queryKey: followUpKeys.list(ticketId),
    queryFn: () => api.get<FollowUp[]>(`/tickets/${ticketId}/follow-ups`),
    enabled: Number.isFinite(ticketId) && ticketId > 0,
  });
}

/** Schedule a new follow-up on a ticket. */
export function useCreateFollowUp(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { dueAt: string; note?: string }) =>
      api.post<FollowUp>(`/tickets/${ticketId}/follow-ups`, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: followUpKeys.list(ticketId) }),
  });
}

/** Mark a follow-up complete or incomplete. */
export function useToggleFollowUp(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, completed }: { id: number; completed: boolean }) =>
      api.patch<FollowUp>(`/follow-ups/${id}`, { completed }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: followUpKeys.list(ticketId) }),
  });
}

/** Delete a follow-up. */
export function useDeleteFollowUp(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<{ deleted: boolean }>(`/follow-ups/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: followUpKeys.list(ticketId) }),
  });
}
