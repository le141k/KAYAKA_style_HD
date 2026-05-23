'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── API shapes (mirror CustomFieldsService.listByScope on the API) ───
export interface PublicCustomField {
  id: number;
  fieldKey: string;
  title: string;
  type: string;
  isRequired: boolean;
  displayOrder: number;
  options: string[];
}

export interface PublicCustomFieldGroup {
  id: number;
  title: string;
  scope: string;
  displayOrder: number;
  fields: PublicCustomField[];
}

/**
 * Fetches the read-only custom-field groups for a scope (default TICKET) so the
 * staff-create and client-submit forms can render dynamic inputs and send the
 * collected `customFields` map on submit. Required custom fields otherwise block
 * ticket creation invisibly (API 400 with no field rendered).
 */
export function useCustomFieldGroups(scope: 'TICKET' | 'USER' | 'ORGANIZATION' = 'TICKET') {
  return useQuery({
    queryKey: ['custom-fields', 'public', scope],
    queryFn: async () => {
      try {
        const groups = await api.get<PublicCustomFieldGroup[]>(`/custom-fields/public?scope=${scope}`);
        return Array.isArray(groups) ? groups : [];
      } catch {
        return [];
      }
    },
    staleTime: 5 * 60_000,
  });
}

/** Flattened, ordered list of fields across all groups for a scope. */
export function useCustomFields(scope: 'TICKET' | 'USER' | 'ORGANIZATION' = 'TICKET') {
  const query = useCustomFieldGroups(scope);
  const fields = (query.data ?? []).flatMap((g) => g.fields).sort((a, b) => a.displayOrder - b.displayOrder);
  return { ...query, fields };
}
