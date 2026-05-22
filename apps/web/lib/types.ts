export type TicketStatus =
  | "open"
  | "pending"
  | "in_progress"
  | "resolved"
  | "closed";

export type TicketPriority = "urgent" | "high" | "normal" | "low";

export type UserRole = "admin" | "agent" | "client";

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  avatar_url?: string;
  department_id?: number;
}

export interface Department {
  id: number;
  name: string;
  email?: string;
  description?: string;
}

export interface TicketPriorityObj {
  id: number;
  name: string;
  slug: TicketPriority;
  color?: string;
}

export interface TicketStatusObj {
  id: number;
  name: string;
  slug: TicketStatus;
  color?: string;
}

export interface SLAPlan {
  id: number;
  name: string;
  first_response_minutes: number;
  resolution_minutes: number;
}

export interface Attachment {
  id: number;
  filename: string;
  size: number;
  url: string;
  mime_type: string;
}

export interface Reply {
  id: number;
  ticket_id: number;
  author: User;
  body: string;
  is_internal: boolean;
  created_at: string;
  attachments?: Attachment[];
}

export interface Ticket {
  id: number;
  mask: string;
  subject: string;
  body: string;
  status: TicketStatus;
  priority: TicketPriority;
  requester: User;
  assignee?: User;
  department?: Department;
  sla_plan?: SLAPlan;
  sla_due_at?: string;
  created_at: string;
  updated_at: string;
  reply_count: number;
  tags?: string[];
  replies?: Reply[];
}

export interface KBCategory {
  id: number;
  name: string;
  description?: string;
  article_count: number;
}

export interface KBArticle {
  id: number;
  slug: string;
  title: string;
  body: string;
  category: KBCategory;
  author: User;
  created_at: string;
  views: number;
}

export interface DashboardStats {
  open_tickets: number;
  pending_tickets: number;
  resolved_today: number;
  sla_breached: number;
  avg_first_response_minutes: number;
}

export interface AuthStaffPrincipal {
  staffId: number;
  email: string;
  isAdmin: boolean;
  permissions: string[];
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  staff: AuthStaffPrincipal;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
}
