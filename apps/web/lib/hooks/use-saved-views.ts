'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// A persisted, named set of ticket-list filters owned by the current staff.
// `filters` is free-form list state (e.g. { status, priority, departmentId }).
export interface SavedView {
  id: number;
  staffId: number;
  name: string;
  filters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSavedViewInput {
  name: string;
  filters: Record<string, unknown>;
}

export const savedViewKeys = {
  all: ['saved-views'] as const,
};

export function useSavedViews() {
  return useQuery({
    queryKey: savedViewKeys.all,
    queryFn: () => api.get<SavedView[]>('/saved-views'),
    staleTime: 60_000,
  });
}

export function useCreateSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSavedViewInput) => api.post<SavedView>('/saved-views', input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: savedViewKeys.all }),
  });
}

export function useDeleteSavedView() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/saved-views/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: savedViewKeys.all }),
  });
}
