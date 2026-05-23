'use client';

/**
 * Client-portal ticket hooks.
 *
 * Uses the public /tickets/my?email=<requesterEmail> endpoint instead of the
 * permission-gated staff /tickets list, so unauthenticated / client users can
 * see their own tickets without having a staff session.
 *
 * The reply mutation first tries the authenticated route
 * POST /tickets/:id/reply, then falls back to the public
 * POST /tickets/public/:id/reply so the page still works while the
 * backend wires the public reply endpoint.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '@/lib/api';
import type { Ticket, Reply, User, Department, PaginatedResponse } from '@/lib/types';

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
    replies: t.posts?.map(mapPostToReply),
  } as Ticket;
}

// ─── Query Keys ──────────────────────────────────────────────────────────────
export const clientTicketKeys = {
  all: ['client-tickets'] as const,
  lists: () => [...clientTicketKeys.all, 'list'] as const,
  list: (email: string) => [...clientTicketKeys.lists(), email] as const,
  detail: (id: number) => [...clientTicketKeys.all, 'detail', id] as const,
};

/** Get the requester email stored after client login. */
function getRequesterEmail(): string {
  if (typeof window === 'undefined') return '';
  // Stored during client login in localStorage as 'client_email'
  return localStorage.getItem('client_email') ?? '';
}

/**
 * Fetches tickets for the currently logged-in client user via
 * GET /tickets/my?email=<requesterEmail>
 */
export function useClientTickets() {
  return useQuery({
    queryKey: clientTicketKeys.list(getRequesterEmail()),
    queryFn: async (): Promise<PaginatedResponse<Ticket>> => {
      const email = getRequesterEmail();
      if (!email) {
        return { data: [], total: 0, page: 1, per_page: 25 };
      }
      try {
        const res = await api.get<{ data: ApiTicket[]; total: number }>(
          `/tickets/my?email=${encodeURIComponent(email)}`,
        );
        return {
          data: res.data.map(mapTicket),
          total: res.total,
          page: 1,
          per_page: 25,
        };
      } catch {
        // Graceful degradation: return empty list rather than crashing
        return { data: [], total: 0, page: 1, per_page: 25 };
      }
    },
    staleTime: 30_000,
  });
}

/**
 * Fetches a single ticket for the client.  Tries the staff detail route
 * first (works if the client has a staff session), then falls back to
 * the public route GET /tickets/public/:id.
 */
export function useClientTicket(id: number) {
  return useQuery({
    queryKey: clientTicketKeys.detail(id),
    queryFn: async (): Promise<Ticket | null> => {
      try {
        return mapTicket(await api.get<ApiTicket>(`/tickets/${id}`));
      } catch {
        try {
          return mapTicket(await api.get<ApiTicket>(`/tickets/public/${id}`));
        } catch {
          return null;
        }
      }
    },
    enabled: id > 0,
  });
}

export interface ClientReplyInput {
  contents: string;
}

/**
 * Posts a public reply.  Tries POST /tickets/:id/reply first (authenticated),
 * then falls back to POST /tickets/public/:id/reply.
 */
export function useClientReply(ticketId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (data: ClientReplyInput) => {
      try {
        return await api.post(`/tickets/${ticketId}/reply`, { contents: data.contents });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          // Fall back to the public reply endpoint, including the stored email so
          // the post is attributed to the right requester.
          const requesterEmail = getRequesterEmail() || undefined;
          return api.post(`/tickets/public/${ticketId}/reply`, {
            contents: data.contents,
            ...(requesterEmail ? { requesterEmail } : {}),
          });
        }
        throw err;
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: clientTicketKeys.detail(ticketId) });
    },
  });
}
