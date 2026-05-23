'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Ticket, Reply, PaginatedResponse, DashboardStats, User, Department } from '@/lib/types';
import { MOCK_TICKETS, MOCK_REPLIES, MOCK_STATS } from '@/lib/mock-data';

// ─── API raw shapes (backend) ───────────────────────────────────────────────
interface ApiRef {
  id: number;
  title: string;
}
interface ApiStaffRef {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}
interface ApiStaffRel {
  firstName: string;
  lastName: string;
  email: string;
}
interface ApiPost {
  id: number;
  ticketId: number;
  authorType: 'STAFF' | 'USER' | 'SYSTEM';
  staffId?: number | null;
  userId?: number | null;
  fullName?: string;
  email?: string;
  contents: string;
  createdAt: string;
  staff?: ApiStaffRel | null;
}
interface ApiNote {
  id: number;
  ticketId: number;
  staffId?: number | null;
  contents: string;
  createdAt: string;
  staff?: ApiStaffRel | null;
}
interface ApiTicket {
  id: number;
  mask: string;
  subject: string;
  statusId: number;
  priorityId: number;
  typeId?: number | null;
  departmentId: number;
  userId?: number | null;
  requesterName?: string;
  requesterEmail?: string;
  ownerStaffId?: number | null;
  slaPlanId?: number | null;
  dueAt?: string | null;
  createdAt: string;
  updatedAt: string;
  totalReplies?: number;
  status?: ApiRef;
  priority?: ApiRef;
  type?: ApiRef | null;
  department?: ApiRef;
  owner?: ApiStaffRef | null;
  user?: { id: number; fullName: string; emails?: { email: string; isPrimary: boolean }[] } | null;
  posts?: ApiPost[];
  notes?: ApiNote[];
  tags?: { name: string }[];
}

function staffName(s?: ApiStaffRel | null): string | undefined {
  if (!s) return undefined;
  return `${s.firstName} ${s.lastName}`.trim() || s.email;
}

// ─── Mappers: API → frontend view models ────────────────────────────────────
const STATUS_SLUGS = ['open', 'pending', 'in_progress', 'resolved', 'closed'] as const;
const PRIORITY_SLUGS = ['urgent', 'high', 'normal', 'low'] as const;

function statusSlug(title?: string): Ticket['status'] {
  const s = (title ?? '').toLowerCase().replace(/\s+/g, '_');
  return (STATUS_SLUGS as readonly string[]).includes(s) ? (s as Ticket['status']) : 'open';
}
function prioritySlug(title?: string): Ticket['priority'] {
  const p = (title ?? '').toLowerCase();
  return (PRIORITY_SLUGS as readonly string[]).includes(p) ? (p as Ticket['priority']) : 'normal';
}

function mapPostToReply(p: ApiPost): Reply {
  return {
    id: p.id,
    ticket_id: p.ticketId,
    author: {
      id: p.staffId ?? p.userId ?? 0,
      name: p.fullName || staffName(p.staff) || p.email || '—',
      email: p.email ?? p.staff?.email ?? '',
      role: p.authorType === 'STAFF' ? 'agent' : 'client',
    } as User,
    body: p.contents,
    is_internal: false,
    created_at: p.createdAt,
  };
}

// Internal notes live in a separate table; surface them in the thread flagged
// as internal (staff-only).
function mapNoteToReply(n: ApiNote): Reply {
  return {
    id: 1_000_000_000 + n.id, // offset to avoid id collision with posts
    ticket_id: n.ticketId,
    author: {
      id: n.staffId ?? 0,
      name: staffName(n.staff) || '—',
      email: n.staff?.email ?? '',
      role: 'agent',
    } as User,
    body: n.contents,
    is_internal: true,
    created_at: n.createdAt,
  };
}

function mapTicket(t: ApiTicket): Ticket {
  const primaryEmail = t.user?.emails?.find((e) => e.isPrimary)?.email ?? t.requesterEmail ?? '';
  const requester: User = {
    id: t.userId ?? 0,
    name: t.requesterName || t.user?.fullName || t.requesterEmail || '—',
    email: t.requesterEmail || primaryEmail,
    role: 'client',
  } as User;
  const assignee: User | undefined = t.owner
    ? ({
        id: t.owner.id,
        name: `${t.owner.firstName} ${t.owner.lastName}`.trim() || t.owner.email,
        email: t.owner.email,
        role: 'agent',
      } as User)
    : undefined;
  const department: Department | undefined = t.department
    ? ({ id: t.department.id, name: t.department.title } as Department)
    : undefined;
  return {
    id: t.id,
    mask: t.mask,
    subject: t.subject,
    body: t.posts?.[0]?.contents ?? '',
    status: statusSlug(t.status?.title),
    priority: prioritySlug(t.priority?.title),
    requester,
    assignee,
    department,
    sla_due_at: t.dueAt ?? undefined,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    reply_count: t.totalReplies ?? 0,
    tags: t.tags?.map((tag) => tag.name),
    replies: [...(t.posts?.map(mapPostToReply) ?? []), ...(t.notes?.map(mapNoteToReply) ?? [])].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    ),
  } as Ticket;
}

// ─── Query Keys ─────────────────────────────────────────────────────────────
export const ticketKeys = {
  all: ['tickets'] as const,
  lists: () => [...ticketKeys.all, 'list'] as const,
  list: (params: Record<string, unknown>) => [...ticketKeys.lists(), params] as const,
  detail: (id: number) => [...ticketKeys.all, 'detail', id] as const,
  replies: (id: number) => [...ticketKeys.all, id, 'replies'] as const,
  stats: ['dashboard-stats'] as const,
};

export interface TicketListParams {
  page?: number;
  per_page?: number;
  status?: string;
  priority?: string;
  department_id?: number;
  assignee_id?: number;
  q?: string;
  date_from?: string;
  date_to?: string;
  /** Skip the query entirely (e.g. command palette while closed). */
  enabled?: boolean;
}

// Resolve a status/priority slug to its backend id so filtering happens
// server-side (client-side filtering only saw the current page → wrong counts).
async function statusIdForSlug(slug: string): Promise<number | undefined> {
  const statuses = await api.get<ApiRef[]>('/ticket-statuses');
  return statuses.find((s) => statusSlug(s.title) === slug)?.id;
}
async function priorityIdForSlug(slug: string): Promise<number | undefined> {
  const priorities = await api.get<ApiRef[]>('/ticket-priorities');
  return priorities.find((p) => prioritySlug(p.title) === slug)?.id;
}

export function useTickets(params: TicketListParams = {}) {
  return useQuery({
    queryKey: ticketKeys.list(params as Record<string, unknown>),
    queryFn: async (): Promise<PaginatedResponse<Ticket>> => {
      try {
        const qs = new URLSearchParams();
        qs.set('limit', String(params.per_page ?? 25));
        if (params.page) qs.set('page', String(params.page));
        if (params.q) qs.set('search', params.q);
        if (params.department_id) qs.set('departmentId', String(params.department_id));
        if (params.assignee_id) qs.set('ownerStaffId', String(params.assignee_id));
        if (params.date_from) qs.set('createdAfter', params.date_from);
        if (params.date_to) qs.set('createdBefore', params.date_to);
        // Map slug filters → ids and push to the server (correct totals + paging).
        if (params.status) {
          const id = await statusIdForSlug(params.status);
          if (id) qs.set('statusId', String(id));
        }
        if (params.priority) {
          const id = await priorityIdForSlug(params.priority);
          if (id) qs.set('priorityId', String(id));
        }
        const res = await api.get<{ data: ApiTicket[]; total: number }>(`/tickets?${qs}`);
        const data = res.data.map(mapTicket);
        return { data, total: res.total, page: params.page ?? 1, per_page: params.per_page ?? 25 };
      } catch {
        let data = [...MOCK_TICKETS];
        if (params.status) data = data.filter((t) => t.status === params.status);
        if (params.q) {
          const q = params.q.toLowerCase();
          data = data.filter((t) => t.subject.toLowerCase().includes(q) || t.mask.toLowerCase().includes(q));
        }
        return { data, total: data.length, page: params.page ?? 1, per_page: params.per_page ?? 25 };
      }
    },
    staleTime: 30_000,
    enabled: params.enabled ?? true,
  });
}

export function useTicket(id: number) {
  return useQuery({
    queryKey: ticketKeys.detail(id),
    queryFn: async () => {
      try {
        return mapTicket(await api.get<ApiTicket>(`/tickets/${id}`));
      } catch {
        return MOCK_TICKETS.find((t) => t.id === id) ?? null;
      }
    },
    enabled: id > 0,
  });
}

// Replies are embedded in the ticket detail (posts[]); derive them here.
export function useReplies(ticketId: number) {
  return useQuery({
    queryKey: ticketKeys.replies(ticketId),
    queryFn: async () => {
      try {
        const t = await api.get<ApiTicket>(`/tickets/${ticketId}`);
        return (t.posts ?? []).map(mapPostToReply);
      } catch {
        return MOCK_REPLIES.filter((r) => r.ticket_id === ticketId);
      }
    },
    enabled: ticketId > 0,
  });
}

export interface CreateTicketInput {
  subject: string;
  body: string;
  requesterEmail: string;
  requesterName?: string;
  priority?: string;
  department_id?: number;
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTicketInput) =>
      api.post<ApiTicket>('/tickets', {
        subject: data.subject,
        contents: data.body,
        requesterEmail: data.requesterEmail,
        requesterName: data.requesterName ?? data.requesterEmail,
        departmentId: data.department_id,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
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
      api.post<ApiTicket>('/tickets/public', {
        ...data,
        requesterName: data.requesterName ?? data.requesterEmail,
      }),
  });
}

export interface CreateReplyInput {
  body: string;
  is_internal?: boolean;
}

export function useReply(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateReplyInput) =>
      data.is_internal
        ? api.post(`/tickets/${ticketId}/notes`, { contents: data.body })
        : api.post(`/tickets/${ticketId}/reply`, { contents: data.body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.replies(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

// Status/priority updates map slug → id via the reference endpoints, then hit
// the dedicated sub-resource PATCH routes.
export function useUpdateTicket(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: Partial<Pick<Ticket, 'status' | 'priority'>> & { assigneeId?: number | null },
    ) => {
      if (data.status) {
        const statuses = await api.get<ApiRef[]>('/ticket-statuses');
        const match = statuses.find((s) => statusSlug(s.title) === data.status);
        if (match) await api.patch(`/tickets/${ticketId}/status`, { statusId: match.id });
      }
      if (data.priority) {
        const priorities = await api.get<ApiRef[]>('/ticket-priorities');
        const match = priorities.find((p) => prioritySlug(p.title) === data.priority);
        if (match) await api.patch(`/tickets/${ticketId}/priority`, { priorityId: match.id });
      }
      if (data.assigneeId !== undefined) {
        // API schema is { ownerStaffId } — { staffId } was silently rejected (400).
        await api.patch(`/tickets/${ticketId}/assign`, { ownerStaffId: data.assigneeId });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Generic status change for any ticket id (used by the kanban drag-and-drop).
export function useChangeTicketStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ ticketId, status }: { ticketId: number; status: Ticket['status'] }) => {
      const id = await statusIdForSlug(status);
      if (id) await api.patch(`/tickets/${ticketId}/status`, { statusId: id });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Real staff list for the assignee picker (replaces hardcoded MOCK_USERS).
interface ApiStaffOption {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}
export interface AssigneeOption {
  value: string;
  label: string;
  description: string;
}
export function useStaffOptions() {
  return useQuery({
    queryKey: ['staff', 'options'],
    queryFn: async (): Promise<AssigneeOption[]> => {
      const res = await api.get<{ data: ApiStaffOption[] }>('/staff?limit=100');
      return res.data.map((s) => ({
        value: String(s.id),
        label: `${s.firstName} ${s.lastName}`.trim() || s.email,
        description: s.email,
      }));
    },
    staleTime: 5 * 60_000,
  });
}

// Dashboard stats: derive the named counters from /reports/dashboard + statuses.
export function useDashboardStats() {
  return useQuery({
    queryKey: ticketKeys.stats,
    queryFn: async (): Promise<DashboardStats> => {
      try {
        const [dash, statuses] = await Promise.all([
          api.get<{
            total: number;
            resolved: number;
            slaBreached?: number;
            avgFirstResponseMinutes?: number;
            byStatus: { key: number; count: number }[];
          }>('/reports/dashboard'),
          api.get<ApiRef[]>('/ticket-statuses'),
        ]);
        const idToSlug = new Map(statuses.map((s) => [s.id, statusSlug(s.title)]));
        const countBy = (slug: string) =>
          dash.byStatus.filter((b) => idToSlug.get(b.key) === slug).reduce((a, b) => a + b.count, 0);
        return {
          open_tickets: countBy('open'),
          pending_tickets: countBy('pending'),
          resolved_today: dash.resolved,
          sla_breached: dash.slaBreached ?? 0,
          avg_first_response_minutes: dash.avgFirstResponseMinutes ?? 0,
        };
      } catch {
        return MOCK_STATS;
      }
    },
    staleTime: 60_000,
  });
}
