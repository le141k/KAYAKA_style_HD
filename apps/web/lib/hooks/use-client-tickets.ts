'use client';

/**
 * Client-portal ticket hooks (GOAL_PUBLIC_SECURITY S2).
 *
 * All ownership is enforced server-side by the verified `th_client` session cookie
 * (bound to a stable `userId`) — there is no caller-supplied `?email=` and no staff-route
 * fallback. Requests go through `clientFetch` (raw fetch + credentials), keeping the client
 * session cleanly separate from the staff JWT flow.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clientFetch } from './use-client-auth';
import type { Ticket, Reply, User, Department, PaginatedResponse, Attachment } from '@/lib/types';

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '') + '/api';

// ─── API raw shapes (mirrors use-tickets.ts) ────────────────────────────────
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
interface ApiAttachment {
  id: number;
  // The API serializes the Prisma column as `fileName` (camelCase); older/other routes may
  // use `filename`. Accept both so the client never shows an `undefined` attachment name.
  fileName?: string;
  filename?: string;
  size: number;
  storageKey?: string;
  mimeType?: string;
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
  user?: { id: number; fullName: string; emails?: { email: string; isPrimary: boolean }[] } | null;
  posts?: ApiPost[];
  tags?: { name: string }[];
}

// ─── Mappers ─────────────────────────────────────────────────────────────────
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

function mapApiAttachment(a: ApiAttachment): Attachment {
  // S2-8: the client downloads via the owner-scoped, session-protected route
  // (NOT the staff /attachments/:id/download route).
  const url = `${API_BASE}/attachments/client/${a.id}/download`;
  return {
    id: a.id,
    filename: a.fileName ?? a.filename ?? 'attachment',
    size: a.size,
    url,
    mime_type: a.mimeType ?? 'application/octet-stream',
  };
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
    attachments: p.attachments?.map(mapApiAttachment),
  };
}

export function mapTicket(t: ApiTicket): Ticket {
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
    // posts[0] is the original message (rendered separately as the body); replies
    // are the rest — slice(1) so the first message isn't shown twice (mirror staff).
    replies: t.posts?.slice(1).map(mapPostToReply),
  } as Ticket;
}

// ─── Query Keys ──────────────────────────────────────────────────────────────
export const clientTicketKeys = {
  all: ['client-tickets'] as const,
  lists: () => [...clientTicketKeys.all, 'list'] as const,
  list: () => [...clientTicketKeys.lists()] as const,
  detail: (id: number) => [...clientTicketKeys.all, 'detail', id] as const,
};

/**
 * Fetches the signed-in client's own tickets via GET /tickets/my (S2-7). Ownership is the
 * server-side `th_client` session bound to a stable `userId` — no caller-supplied email. Only
 * call this when a session exists (the page gates on `useClientSession`); a 401 rejects so the
 * page can send the user back to sign-in rather than showing a fake empty list.
 */
export function useClientTickets(enabled = true) {
  return useQuery({
    queryKey: clientTicketKeys.list(),
    queryFn: async (): Promise<PaginatedResponse<Ticket>> => {
      const res = await clientFetch<{ data: ApiTicket[]; total: number }>('/tickets/my');
      return { data: res.data.map(mapTicket), total: res.total, page: 1, per_page: 25 };
    },
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * Fetches one of the client's own tickets via GET /tickets/public/:id (S2-7). The server
 * authorizes by `Ticket.userId === session.userId` and returns the same 404 for a wrong owner,
 * so there is no id-enumeration IDOR. No staff-route fallback, no email.
 */
export function useClientTicket(id: number) {
  return useQuery({
    queryKey: clientTicketKeys.detail(id),
    queryFn: async (): Promise<Ticket | null> => {
      try {
        return mapTicket(await clientFetch<ApiTicket>(`/tickets/public/${id}`));
      } catch (e) {
        // 404 (not owned / not found) → render "not found"; a real failure must surface.
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    },
    enabled: id > 0,
    retry: false,
  });
}

export interface ClientReplyInput {
  contents: string;
  attachmentIds?: number[];
  attachmentClaimToken?: string;
}

/**
 * Posts a reply to the client's own ticket via POST /tickets/public/:id/reply (S2-7). The
 * author is taken from the session on the server, never from a request field.
 */
export function useClientReply(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: ClientReplyInput) =>
      clientFetch(`/tickets/public/${ticketId}/reply`, {
        method: 'POST',
        body: JSON.stringify({
          contents: data.contents,
          ...(data.attachmentIds?.length ? { attachmentIds: data.attachmentIds } : {}),
          ...(data.attachmentClaimToken ? { attachmentClaimToken: data.attachmentClaimToken } : {}),
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: clientTicketKeys.detail(ticketId) });
    },
  });
}
