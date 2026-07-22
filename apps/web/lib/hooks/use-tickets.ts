'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Ticket, Reply, PaginatedResponse, DashboardStats, User, Department } from '@/lib/types';

const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

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
interface ApiAttachment {
  id: number;
  fileName: string;
  mimeType: string;
  size: number;
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
  attachments?: ApiAttachment[];
  outboundEmail?: {
    state: 'QUEUED' | 'PROCESSING' | 'SENT' | 'RETRY' | 'FAILED' | 'AMBIGUOUS';
    attempts: number;
    nextAttemptAt?: string | null;
    lastError?: string | null;
    sentAt?: string | null;
  } | null;
}
interface ApiNote {
  id: number;
  ticketId: number;
  staffId?: number | null;
  contents: string;
  createdAt: string;
  staff?: ApiStaffRel | null;
  attachments?: ApiAttachment[];
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
  user?: {
    id: number;
    fullName: string;
    emails?: { email: string; isPrimary: boolean }[];
    organization?: { id: number; name: string } | null;
  } | null;
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
    attachments: p.attachments?.map((a) => ({
      id: a.id,
      filename: a.fileName,
      size: a.size,
      mime_type: a.mimeType,
      url: `${API_URL}/attachments/${a.id}/download`,
    })),
    ...(p.outboundEmail
      ? {
          delivery: {
            state: p.outboundEmail.state,
            attempts: p.outboundEmail.attempts,
            next_attempt_at: p.outboundEmail.nextAttemptAt,
            last_error: p.outboundEmail.lastError,
            sent_at: p.outboundEmail.sentAt,
          },
        }
      : {}),
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
    attachments: n.attachments?.map((a) => ({
      id: a.id,
      filename: a.fileName,
      size: a.size,
      mime_type: a.mimeType,
      url: `${API_URL}/attachments/${a.id}/download`,
    })),
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
    typeId: t.typeId ?? undefined,
    typeName: t.type?.title ?? undefined,
    requester,
    assignee,
    organization: t.user?.organization
      ? { id: t.user.organization.id, name: t.user.organization.name }
      : undefined,
    department,
    sla_due_at: t.dueAt ?? undefined,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    reply_count: t.totalReplies ?? 0,
    tags: t.tags?.map((tag) => tag.name),
    // posts[0] is rendered separately as the original message (ticket.body); skip it
    // here so it isn't duplicated in the conversation thread.
    replies: [...(t.posts?.slice(1).map(mapPostToReply) ?? []), ...(t.notes?.map(mapNoteToReply) ?? [])].sort(
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
  links: (id: number) => [...ticketKeys.all, id, 'links'] as const,
  watchers: (id: number) => [...ticketKeys.all, id, 'watchers'] as const,
  recipients: (id: number) => [...ticketKeys.all, id, 'recipients'] as const,
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
  /** Only tickets whose SLA due date is in the past (filtered client-side per page). */
  sla_breached?: boolean;
  /** Server-side sort field. */
  sort_by?: 'createdAt' | 'lastActivityAt' | 'lastReplyAt';
  sort_dir?: 'asc' | 'desc';
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
      // No mock fallback: on API error the query rejects so the UI shows a real
      // error state (never fake/empty data presented as real).
      const qs = new URLSearchParams();
      qs.set('limit', String(params.per_page ?? 25));
      if (params.page) qs.set('page', String(params.page));
      if (params.q) qs.set('search', params.q);
      if (params.department_id) qs.set('departmentId', String(params.department_id));
      if (params.assignee_id) qs.set('ownerStaffId', String(params.assignee_id));
      if (params.date_from) qs.set('createdAfter', params.date_from);
      if (params.date_to) qs.set('createdBefore', params.date_to);
      if (params.sort_by) qs.set('sortBy', params.sort_by);
      if (params.sort_dir) qs.set('sortDir', params.sort_dir);
      // SLA breach is now filtered server-side (correct totals across pages).
      if (params.sla_breached) qs.set('sla_breached', 'true');
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
    },
    staleTime: 30_000,
    enabled: params.enabled ?? true,
  });
}

export function useTicket(id: number) {
  return useQuery({
    queryKey: ticketKeys.detail(id),
    queryFn: async () => mapTicket(await api.get<ApiTicket>(`/tickets/${id}`)),
    enabled: id > 0,
  });
}

// Replies are embedded in the ticket detail (posts[]); derive them here.
export function useReplies(ticketId: number) {
  return useQuery({
    queryKey: ticketKeys.replies(ticketId),
    queryFn: async () => {
      const t = await api.get<ApiTicket>(`/tickets/${ticketId}`);
      return (t.posts ?? []).map(mapPostToReply);
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
  customFields?: Record<string, unknown>;
}

export function useCreateTicket() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: CreateTicketInput) => {
      // Map the priority slug → id (API wants priorityId); departmentId is required.
      let priorityId: number | undefined;
      if (data.priority) priorityId = await priorityIdForSlug(data.priority);
      return api.post<ApiTicket>('/tickets', {
        subject: data.subject,
        contents: data.body,
        requesterEmail: data.requesterEmail,
        requesterName: data.requesterName ?? data.requesterEmail,
        departmentId: data.department_id,
        ...(priorityId ? { priorityId } : {}),
        ...(data.customFields && Object.keys(data.customFields).length
          ? { customFields: data.customFields }
          : {}),
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
  });
}

export type BulkInput =
  | { ids: number[]; action: 'status'; status: string }
  | { ids: number[]; action: 'assignee'; ownerStaffId: number | null }
  | { ids: number[]; action: 'unassign' };

export interface BulkResult {
  updated: number;
  failed: number[];
}

/** Apply one action (status / assignee / unassign) to many tickets at once. */
export function useBulkTicketAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: BulkInput): Promise<BulkResult> => {
      if (input.action === 'status') {
        const statusId = await statusIdForSlug(input.status);
        return api.post<BulkResult>('/tickets/bulk', { ids: input.ids, action: 'status', statusId });
      }
      if (input.action === 'unassign') {
        return api.post<BulkResult>('/tickets/bulk', { ids: input.ids, action: 'unassign' });
      }
      return api.post<BulkResult>('/tickets/bulk', {
        ids: input.ids,
        action: 'assignee',
        ownerStaffId: input.ownerStaffId,
      });
    },
    // Invalidate ALL ticket queries (lists + any open ticket-detail) so a bulk
    // change to a ticket that's currently open on screen refreshes too.
    onSuccess: () => void qc.invalidateQueries({ queryKey: ticketKeys.all }),
  });
}

// Public (unauthenticated) submission from the client portal → POST /tickets/public.
export interface PublicTicketInput {
  challengeToken: string;
  subject: string;
  contents: string;
  requesterEmail: string;
  requesterName?: string;
  departmentId?: number;
  attachmentIds?: number[];
  /** Per-upload secret echoed from POST /attachments/upload/public (orphan-claim scope). */
  attachmentClaimToken?: string;
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
  attachmentIds?: number[];
}

export function useReply(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateReplyInput) =>
      data.is_internal
        ? api.post(`/tickets/${ticketId}/notes`, {
            contents: data.body,
            ...(data.attachmentIds?.length ? { attachmentIds: data.attachmentIds } : {}),
          })
        : api.post(`/tickets/${ticketId}/reply`, {
            contents: data.body,
            ...(data.attachmentIds?.length ? { attachmentIds: data.attachmentIds } : {}),
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.replies(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    },
  });
}

// Status/priority/type updates map slug → id via the reference endpoints, then hit
// the dedicated sub-resource PATCH routes.
export function useUpdateTicket(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      data: Partial<Pick<Ticket, 'status' | 'priority'>> & {
        assigneeId?: number | null;
        typeId?: number | null;
      },
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
      if (data.typeId !== undefined) {
        await api.patch(`/tickets/${ticketId}/type`, { typeId: data.typeId });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Change a ticket's department (PATCH /tickets/:id/department, body { departmentId }).
export function useChangeTicketDepartment(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (departmentId: number) => api.patch(`/tickets/${ticketId}/department`, { departmentId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Apply a macro to a ticket (POST /tickets/:id/apply-macro, body { macroId }).
export function useApplyMacro(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (macroId: number) => api.post(`/tickets/${ticketId}/apply-macro`, { macroId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.replies(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Macro picker options (id + title) from the admin macros endpoint.
export interface MacroOption {
  value: string;
  label: string;
}
export function useMacroOptions() {
  return useQuery({
    queryKey: ['macros', 'options'],
    queryFn: async (): Promise<MacroOption[]> => {
      // Agent-accessible picker endpoint (TICKET_EDIT); the full /admin/macros
      // list requires ADMIN_WORKFLOW which agents lack (would 403 → empty picker).
      const res = await api.get<{ id: number; title: string }[]>('/admin/macros/options');
      return res.map((m) => ({ value: String(m.id), label: m.title }));
    },
    staleTime: 5 * 60_000,
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
    // Optimistic rollback: snapshot previous cache entry, restore on error.
    onMutate: async ({ ticketId, status }) => {
      await qc.cancelQueries({ queryKey: ticketKeys.lists() });
      const snapshots = qc.getQueriesData<PaginatedResponse<Ticket>>({ queryKey: ticketKeys.lists() });
      // Optimistically update all list caches
      qc.setQueriesData<PaginatedResponse<Ticket>>({ queryKey: ticketKeys.lists() }, (old) => {
        if (!old) return old;
        return {
          ...old,
          data: old.data.map((t) => (t.id === ticketId ? { ...t, status } : t)),
        };
      });
      return { snapshots };
    },
    onError: (_err, _vars, ctx) => {
      // Restore all snapshotted list caches
      if (ctx?.snapshots) {
        for (const [key, data] of ctx.snapshots) {
          qc.setQueryData(key, data);
        }
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// Add / remove a tag on a ticket (TICKET_EDIT). Used by the ticket detail panel.
export interface TicketLink {
  linkId: number;
  linkType: string;
  ticket: { id: number; mask: string; subject: string; status: string | null; isResolved: boolean };
}

/** Linked client↔supplier tickets for the ticket-detail "Связанные тикеты" panel. */
export function useTicketLinks(ticketId: number) {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ticketKeys.links(ticketId) });
  const list = useQuery({
    queryKey: ticketKeys.links(ticketId),
    queryFn: () => api.get<TicketLink[]>(`/tickets/${ticketId}/links`),
  });
  const add = useMutation({
    mutationFn: (input: { targetId: number; linkType: 'supplier' | 'client' | 'related' }) =>
      api.post(`/tickets/${ticketId}/links`, input),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (linkId: number) => api.delete(`/tickets/${ticketId}/links/${linkId}`),
    onSuccess: invalidate,
  });
  // The NOC "Contact supplier" action: spawns a Vendor-Issue ticket linked back here.
  const spawnSupplier = useMutation({
    mutationFn: (input: {
      supplierEmail: string;
      supplierName?: string;
      subject?: string;
      contents: string;
    }) => api.post<{ ticket: { id: number; mask: string } }>(`/tickets/${ticketId}/spawn-supplier`, input),
    onSuccess: invalidate,
  });
  return { list, add, remove, spawnSupplier };
}

export function useTicketTags(ticketId: number) {
  const qc = useQueryClient();
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
    void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
  };
  const add = useMutation({
    mutationFn: (name: string) => api.post(`/tickets/${ticketId}/tags`, { name }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/tickets/${ticketId}/tags/${encodeURIComponent(name)}`),
    onSuccess: invalidate,
  });
  return { add, remove };
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
// Department options for create/assign dropdowns.
export interface DepartmentOption {
  value: string;
  label: string;
}
export function useDepartmentOptions() {
  return useQuery({
    queryKey: ['departments', 'options'],
    queryFn: async (): Promise<DepartmentOption[]> => {
      const res = await api.get<{ id: number; title: string }[]>('/departments');
      return res.map((d) => ({ value: String(d.id), label: d.title }));
    },
    staleTime: 5 * 60_000,
  });
}

export function useStaffOptions() {
  return useQuery({
    queryKey: ['staff', 'options'],
    queryFn: async (): Promise<AssigneeOption[]> => {
      // Agent-accessible directory (TICKET_ASSIGN); the full /staff list requires
      // STAFF_MANAGE which agents lack (would 403 → empty assignee picker).
      const res = await api.get<ApiStaffOption[]>('/staff/assignable');
      return res.map((s) => ({
        value: String(s.id),
        label: `${s.firstName} ${s.lastName}`.trim() || s.email,
        description: s.email,
      }));
    },
    staleTime: 5 * 60_000,
  });
}

// Picker options loaded from the API (replaces hardcoded STATUS_OPTIONS/PRIORITY_OPTIONS).
export interface StatusOption {
  value: Ticket['status'];
  label: string;
  id: number;
}
export interface PriorityOption {
  value: Ticket['priority'];
  label: string;
  id: number;
}
export interface TypeOption {
  value: string;
  label: string;
}

export function useStatusOptions() {
  return useQuery({
    queryKey: ['ticket-statuses', 'options'],
    queryFn: async (): Promise<StatusOption[]> => {
      const res = await api.get<ApiRef[]>('/ticket-statuses');
      return res.map((s) => ({ value: statusSlug(s.title), label: s.title, id: s.id }));
    },
    staleTime: 5 * 60_000,
  });
}

export function usePriorityOptions() {
  return useQuery({
    queryKey: ['ticket-priorities', 'options'],
    queryFn: async (): Promise<PriorityOption[]> => {
      const res = await api.get<ApiRef[]>('/ticket-priorities');
      return res.map((p) => ({ value: prioritySlug(p.title), label: p.title, id: p.id }));
    },
    staleTime: 5 * 60_000,
  });
}

export function useTypeOptions() {
  return useQuery({
    queryKey: ['ticket-types', 'options'],
    queryFn: async (): Promise<TypeOption[]> => {
      const res = await api.get<ApiRef[]>('/ticket-types');
      return res.map((ty) => ({ value: String(ty.id), label: ty.title }));
    },
    staleTime: 5 * 60_000,
  });
}

// Dashboard stats: derive the named counters from /reports/dashboard + statuses.
export function useDashboardStats() {
  return useQuery({
    queryKey: ticketKeys.stats,
    queryFn: async (): Promise<DashboardStats> => {
      // No mock fallback: errors propagate so the dashboard can show a real error.
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
    },
    staleTime: 60_000,
  });
}

// ─── Merge / Split ──────────────────────────────────────────────────────────
export function useMergeTicket(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (targetTicketId: number) => api.post(`/tickets/${ticketId}/merge`, { targetTicketId }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

export function useSplitTicket(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { postIds: number[]; subject: string }) =>
      api.post<{ ticket: { id: number; mask: string } }>(`/tickets/${ticketId}/split`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}

// ─── Watchers ───────────────────────────────────────────────────────────────
export interface Watcher {
  staffId: number;
  name: string;
  email: string;
}

export function useTicketWatchers(ticketId: number) {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ticketKeys.watchers(ticketId) });

  const list = useQuery({
    queryKey: ticketKeys.watchers(ticketId),
    queryFn: () => api.get<Watcher[]>(`/tickets/${ticketId}/watchers`),
    enabled: ticketId > 0,
  });

  const add = useMutation({
    mutationFn: (staffId: number) => api.post(`/tickets/${ticketId}/watchers`, { staffId }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (staffId: number) => api.delete(`/tickets/${ticketId}/watchers/${staffId}`),
    onSuccess: invalidate,
  });

  return { list, add, remove };
}

// ─── Recipients (CC / BCC) ──────────────────────────────────────────────────
export interface Recipient {
  id: number;
  email: string;
  name?: string;
  type: 'cc' | 'bcc';
}

export function useTicketRecipients(ticketId: number) {
  const qc = useQueryClient();
  const invalidate = () => void qc.invalidateQueries({ queryKey: ticketKeys.recipients(ticketId) });

  const list = useQuery({
    queryKey: ticketKeys.recipients(ticketId),
    queryFn: () => api.get<Recipient[]>(`/tickets/${ticketId}/recipients`),
    enabled: ticketId > 0,
  });

  const add = useMutation({
    mutationFn: (input: { email: string; name?: string; type: 'cc' | 'bcc' }) =>
      api.post(`/tickets/${ticketId}/recipients`, input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (recipientId: number) => api.delete(`/tickets/${ticketId}/recipients/${recipientId}`),
    onSuccess: invalidate,
  });

  return { list, add, remove };
}
