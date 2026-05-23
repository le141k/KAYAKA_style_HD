'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── API raw shapes (backend) ───────────────────────────────────────────────
export interface TimeEntry {
  id: number;
  ticketId: number;
  staffId: number;
  minutes: number;
  note: string | null;
  spentAt: string;
  createdAt: string;
  staff?: { firstName: string; lastName: string } | null;
}

export interface TimeEntriesResponse {
  entries: TimeEntry[];
  totalMinutes: number;
}

export interface LogTimeInput {
  minutes: number;
  note?: string;
  spentAt?: string;
}

// ─── Query Keys ─────────────────────────────────────────────────────────────
export const timeEntryKeys = {
  all: ['time-entries'] as const,
  list: (ticketId: number) => [...timeEntryKeys.all, ticketId] as const,
};

/** All time entries for a ticket plus the total logged minutes. */
export function useTimeEntries(ticketId: number) {
  return useQuery({
    queryKey: timeEntryKeys.list(ticketId),
    queryFn: () => api.get<TimeEntriesResponse>(`/tickets/${ticketId}/time`),
    enabled: ticketId > 0,
    staleTime: 30_000,
  });
}

/** Log time spent on a ticket by the current staff. */
export function useLogTime(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LogTimeInput) => api.post<TimeEntry>(`/tickets/${ticketId}/time`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: timeEntryKeys.list(ticketId) }),
  });
}

/** Delete a time entry, then refresh the ticket's list. */
export function useDeleteTimeEntry(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/time/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: timeEntryKeys.list(ticketId) }),
  });
}
