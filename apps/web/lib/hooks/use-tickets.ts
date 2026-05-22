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
  tags?: { name: string }[];
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
      name: p.fullName || p.email || '—',
      email: p.email ?? '',
      role: p.authorType === 'STAFF' ? 'agent' : 'client',
    } as User,
    body: p.contents,
    is_internal: false,
    created_at: p.createdAt,
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
    replies: t.posts?.map(mapPostToReply),
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
        const res = await api.get<{ data: ApiTicket[]; total: number }>(`/tickets?${qs}`);
        let data = res.data.map(mapTicket);
        // status/priority dropdowns send slugs; filter client-side after mapping
        if (params.status) data = data.filter((t) => t.status === params.status);
        if (params.priority) data = data.filter((t) => t.priority === params.priority);
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
        await api.patch(`/tickets/${ticketId}/assign`, { staffId: data.assigneeId });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Dashboard stats: derive the named counters from /reports/dashboard + statuses.
export function useDashboardStats() {
  return useQuery({
    queryKey: ticketKeys.stats,
    queryFn: async (): Promise<DashboardStats> => {
      try {
        const [dash, statuses] = await Promise.all([
          api.get<{ total: number; resolved: number; byStatus: { key: number; count: number }[] }>(
            '/reports/dashboard',
          ),
          api.get<ApiRef[]>('/ticket-statuses'),
        ]);
        const idToSlug = new Map(statuses.map((s) => [s.id, statusSlug(s.title)]));
        const countBy = (slug: string) =>
          dash.byStatus.filter((b) => idToSlug.get(b.key) === slug).reduce((a, b) => a + b.count, 0);
        return {
          open_tickets: countBy('open'),
          pending_tickets: countBy('pending'),
          resolved_today: dash.resolved,
          sla_breached: 0,
          avg_first_response_minutes: 0,
        };
      } catch {
        return MOCK_STATS;
      }
    },
    staleTime: 60_000,
  });
}
