'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ─── Raw API shapes ──────────────────────────────────────────────────────────

export interface ApiDepartment {
  id: number;
  title: string;
  type: string;
  app: string;
  isDefault: boolean;
  displayOrder: number;
  parentId: number | null;
  createdAt: string;
  children?: ApiDepartment[];
}

export interface ApiTicketStatus {
  id: number;
  title: string;
  displayOrder: number;
  markAsResolved: boolean;
  color: string;
  bgColor: string;
  displayIcon: string;
  triggersSurvey: boolean;
  isDefault: boolean;
}

export interface ApiTicketPriority {
  id: number;
  title: string;
  displayOrder: number;
  color: string;
  bgColor: string;
}

export interface ApiSlaSchedule {
  id: number;
  title: string;
  workHours: Record<string, string[][]>;
  createdAt?: string;
}

export interface ApiSlaHoliday {
  id: number;
  scheduleId: number;
  title: string;
  date: string;
}

export interface ApiEscalationRule {
  id: number;
  planId: number;
  afterSeconds: number;
  assignGroupId: number | null;
  assignStaffId: number | null;
  notifyGroupId: number | null;
  notifyStaffId: number | null;
}

export interface ApiSlaPlan {
  id: number;
  title: string;
  isEnabled: boolean;
  firstResponseSeconds: number;
  resolutionSeconds: number;
  scheduleId: number | null;
  createdAt: string;
  updatedAt: string;
  escalationRules: ApiEscalationRule[];
}

export interface ApiStaffGroup {
  id: number;
  title: string;
  isAdmin: boolean;
  permissions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiStaffMember {
  id: number;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  designation: string;
  isEnabled: boolean;
  staffGroupId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApiWorkflow {
  id: number;
  title: string;
  isEnabled: boolean;
  sortOrder: number;
  criteria: unknown[];
  actions: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiMacroCategory {
  id: number;
  title: string;
  displayOrder: number;
}

export interface ApiMacro {
  id: number;
  title: string;
  categoryId: number | null;
  isShared: boolean;
  actions: unknown[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiCustomFieldGroup {
  id: number;
  title: string;
  scope: 'TICKET' | 'USER' | 'STAFF' | 'ORGANIZATION';
  displayOrder: number;
  // The list endpoint embeds fields inline; there is no per-group GET route.
  fields?: ApiCustomField[];
}

export interface ApiCustomField {
  id: number;
  groupId: number;
  title: string;
  type: string;
  isRequired: boolean;
  displayOrder: number;
  options: string[];
}

// ─── View models ─────────────────────────────────────────────────────────────

export interface AdminDepartment {
  id: number;
  title: string;
  type: string;
  isDefault: boolean;
  displayOrder: number;
  parentId: number | null;
  children: AdminDepartment[];
}

export interface AdminTicketStatus {
  id: number;
  title: string;
  displayOrder: number;
  markAsResolved: boolean;
  color: string;
  bgColor: string;
  isDefault: boolean;
}

export interface AdminTicketPriority {
  id: number;
  title: string;
  displayOrder: number;
  color: string;
  bgColor: string;
}

export interface AdminSlaPlan {
  id: number;
  title: string;
  isEnabled: boolean;
  firstResponseSeconds: number;
  resolutionSeconds: number;
  scheduleId: number | null;
  escalationRules: ApiEscalationRule[];
}

export interface AdminSlaSchedule {
  id: number;
  title: string;
  workHours: Record<string, string[][]>;
}

export interface AdminSlaHoliday {
  id: number;
  scheduleId: number;
  title: string;
  date: string;
}

export interface AdminStaffMember {
  id: number;
  email: string;
  username: string;
  firstName: string;
  lastName: string;
  fullName: string;
  designation: string;
  isEnabled: boolean;
  staffGroupId: number | null;
}

export interface AdminStaffGroup {
  id: number;
  title: string;
  isAdmin: boolean;
  permissions: string[];
}

export interface AdminWorkflow {
  id: number;
  title: string;
  isEnabled: boolean;
  sortOrder: number;
  criteria: unknown[];
  actions: unknown[];
}

export interface AdminMacroCategory {
  id: number;
  title: string;
  displayOrder: number;
}

export interface AdminMacro {
  id: number;
  title: string;
  categoryId: number | null;
  isShared: boolean;
  actions: unknown[];
}

export interface AdminCustomFieldGroup {
  id: number;
  title: string;
  scope: 'TICKET' | 'USER' | 'STAFF' | 'ORGANIZATION';
  displayOrder: number;
  fields: AdminCustomField[];
}

export interface AdminCustomField {
  id: number;
  groupId: number;
  title: string;
  type: string;
  isRequired: boolean;
  displayOrder: number;
  options: string[];
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

function mapDepartment(d: ApiDepartment): AdminDepartment {
  return {
    id: d.id,
    title: d.title,
    type: d.type,
    isDefault: d.isDefault,
    displayOrder: d.displayOrder,
    parentId: d.parentId,
    children: (d.children ?? []).map(mapDepartment),
  };
}

function mapStatus(s: ApiTicketStatus): AdminTicketStatus {
  return {
    id: s.id,
    title: s.title,
    displayOrder: s.displayOrder,
    markAsResolved: s.markAsResolved,
    color: s.color,
    bgColor: s.bgColor,
    isDefault: s.isDefault,
  };
}

function mapPriority(p: ApiTicketPriority): AdminTicketPriority {
  return { id: p.id, title: p.title, displayOrder: p.displayOrder, color: p.color, bgColor: p.bgColor };
}

function mapSlaPlan(p: ApiSlaPlan): AdminSlaPlan {
  return {
    id: p.id,
    title: p.title,
    isEnabled: p.isEnabled,
    firstResponseSeconds: p.firstResponseSeconds,
    resolutionSeconds: p.resolutionSeconds,
    scheduleId: p.scheduleId,
    escalationRules: p.escalationRules ?? [],
  };
}

function mapSchedule(s: ApiSlaSchedule): AdminSlaSchedule {
  return { id: s.id, title: s.title, workHours: s.workHours };
}

function mapHoliday(h: ApiSlaHoliday): AdminSlaHoliday {
  return { id: h.id, scheduleId: h.scheduleId, title: h.title, date: h.date };
}

function mapStaff(s: ApiStaffMember): AdminStaffMember {
  return {
    id: s.id,
    email: s.email,
    username: s.username,
    firstName: s.firstName,
    lastName: s.lastName,
    fullName: `${s.firstName} ${s.lastName}`.trim() || s.email,
    designation: s.designation,
    isEnabled: s.isEnabled,
    staffGroupId: s.staffGroupId,
  };
}

function mapGroup(g: ApiStaffGroup): AdminStaffGroup {
  return { id: g.id, title: g.title, isAdmin: g.isAdmin, permissions: g.permissions };
}

function mapWorkflow(w: ApiWorkflow): AdminWorkflow {
  return {
    id: w.id,
    title: w.title,
    isEnabled: w.isEnabled,
    sortOrder: w.sortOrder,
    criteria: w.criteria,
    actions: w.actions,
  };
}

function mapMacroCategory(c: ApiMacroCategory): AdminMacroCategory {
  return { id: c.id, title: c.title, displayOrder: c.displayOrder };
}

function mapMacro(m: ApiMacro): AdminMacro {
  return { id: m.id, title: m.title, categoryId: m.categoryId, isShared: m.isShared, actions: m.actions };
}

function mapFieldGroup(g: ApiCustomFieldGroup, fields: ApiCustomField[]): AdminCustomFieldGroup {
  return {
    id: g.id,
    title: g.title,
    scope: g.scope,
    displayOrder: g.displayOrder,
    fields: fields.map((f) => ({
      id: f.id,
      groupId: f.groupId,
      title: f.title,
      type: f.type,
      isRequired: f.isRequired,
      displayOrder: f.displayOrder,
      options: f.options ?? [],
    })),
  };
}

// ─── Query keys ──────────────────────────────────────────────────────────────

export const adminKeys = {
  departments: ['admin', 'departments'] as const,
  statuses: ['admin', 'statuses'] as const,
  priorities: ['admin', 'priorities'] as const,
  slaPlans: ['admin', 'sla', 'plans'] as const,
  slaSchedules: ['admin', 'sla', 'schedules'] as const,
  slaHolidays: (scheduleId: number) => ['admin', 'sla', 'holidays', scheduleId] as const,
  staff: ['admin', 'staff'] as const,
  staffGroups: ['admin', 'staff', 'groups'] as const,
  workflows: ['admin', 'workflows'] as const,
  macroCategories: ['admin', 'macro-categories'] as const,
  macros: (categoryId?: number) => ['admin', 'macros', categoryId] as const,
  customFieldGroups: ['admin', 'custom-field-groups'] as const,
};

// ─── Departments ─────────────────────────────────────────────────────────────

export function useAdminDepartments() {
  return useQuery({
    queryKey: adminKeys.departments,
    queryFn: async () => {
      const data = await api.get<ApiDepartment[]>('/departments/tree');
      return data.map(mapDepartment);
    },
  });
}

export interface DepartmentInput {
  title: string;
  parentId?: number | null;
}

// API schema treats parentId as optional-omitted, not nullable: sending JSON
// `null` (or 0 from an empty <select>) fails validation. Drop it when empty.
function cleanDepartment(data: DepartmentInput): { title: string; parentId?: number } {
  const parentId = data.parentId;
  return parentId == null || parentId === 0 ? { title: data.title } : { title: data.title, parentId };
}

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: DepartmentInput) => api.post<ApiDepartment>('/departments', cleanDepartment(data)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.departments }),
  });
}

export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DepartmentInput }) =>
      api.patch<ApiDepartment>(`/departments/${id}`, cleanDepartment(data)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.departments }),
  });
}

export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/departments/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.departments }),
  });
}

// ─── Ticket statuses ─────────────────────────────────────────────────────────

export function useAdminStatuses() {
  return useQuery({
    queryKey: adminKeys.statuses,
    queryFn: async () => {
      const data = await api.get<ApiTicketStatus[]>('/ticket-statuses');
      return data.map(mapStatus);
    },
  });
}

export interface StatusInput {
  title: string;
  color?: string;
  bgColor?: string;
  markAsResolved?: boolean;
}

export function useCreateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: StatusInput) => api.post<ApiTicketStatus>('/ticket-statuses', data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.statuses }),
  });
}

export function useUpdateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: StatusInput }) =>
      api.patch<ApiTicketStatus>(`/ticket-statuses/${id}`, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.statuses }),
  });
}

export function useDeleteStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/ticket-statuses/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.statuses }),
  });
}

// ─── Ticket priorities ───────────────────────────────────────────────────────

export function useAdminPriorities() {
  return useQuery({
    queryKey: adminKeys.priorities,
    queryFn: async () => {
      const data = await api.get<ApiTicketPriority[]>('/ticket-priorities');
      return data.map(mapPriority);
    },
  });
}

export interface PriorityInput {
  title: string;
  color?: string;
  bgColor?: string;
}

export function useCreatePriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PriorityInput) => api.post<ApiTicketPriority>('/ticket-priorities', data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.priorities }),
  });
}

export function useUpdatePriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: PriorityInput }) =>
      api.patch<ApiTicketPriority>(`/ticket-priorities/${id}`, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.priorities }),
  });
}

export function useDeletePriority() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/ticket-priorities/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.priorities }),
  });
}

// ─── SLA ─────────────────────────────────────────────────────────────────────

export function useAdminSlaPlans() {
  return useQuery({
    queryKey: adminKeys.slaPlans,
    queryFn: async () => {
      const data = await api.get<ApiSlaPlan[]>('/admin/sla/plans');
      return data.map(mapSlaPlan);
    },
  });
}

export interface SlaPlanInput {
  title: string;
  isEnabled?: boolean;
  firstResponseSeconds: number;
  resolutionSeconds: number;
  scheduleId?: number | null;
}

// An empty schedule <select> yields 0 via z.coerce.number(); the API wants a
// positive id or explicit null ("no schedule").
function cleanSlaPlan(data: SlaPlanInput): SlaPlanInput {
  return { ...data, scheduleId: data.scheduleId ? data.scheduleId : null };
}

export function useCreateSlaPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SlaPlanInput) => api.post<ApiSlaPlan>('/admin/sla/plans', cleanSlaPlan(data)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.slaPlans }),
  });
}

export function useUpdateSlaPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: SlaPlanInput }) =>
      api.put<ApiSlaPlan>(`/admin/sla/plans/${id}`, cleanSlaPlan(data)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.slaPlans }),
  });
}

export function useDeleteSlaPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/admin/sla/plans/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.slaPlans }),
  });
}

export function useAdminSlaSchedules() {
  return useQuery({
    queryKey: adminKeys.slaSchedules,
    queryFn: async () => {
      const data = await api.get<ApiSlaSchedule[]>('/admin/sla/schedules');
      return data.map(mapSchedule);
    },
  });
}

export interface SlaScheduleInput {
  title: string;
}

export function useCreateSlaSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SlaScheduleInput) => api.post<ApiSlaSchedule>('/admin/sla/schedules', data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.slaSchedules }),
  });
}

export function useAdminSlaHolidays(scheduleId: number) {
  return useQuery({
    queryKey: adminKeys.slaHolidays(scheduleId),
    queryFn: async () => {
      const data = await api.get<ApiSlaHoliday[]>(`/admin/sla/schedules/${scheduleId}/holidays`);
      return data.map(mapHoliday);
    },
    enabled: scheduleId > 0,
  });
}

export interface SlaHolidayInput {
  title: string;
  date: string;
}

export function useCreateSlaHoliday(scheduleId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: SlaHolidayInput) =>
      api.post<ApiSlaHoliday>(`/admin/sla/schedules/${scheduleId}/holidays`, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.slaHolidays(scheduleId) }),
  });
}

export function useDeleteSlaHoliday(scheduleId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (holidayId: number) =>
      api.delete<void>(`/admin/sla/schedules/${scheduleId}/holidays/${holidayId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.slaHolidays(scheduleId) }),
  });
}

// ─── Staff ───────────────────────────────────────────────────────────────────

export function useAdminStaff() {
  return useQuery({
    queryKey: adminKeys.staff,
    queryFn: async () => {
      // API caps limit at 100 — requesting 200 returns a 400 and the table never loads.
      const res = await api.get<{ data: ApiStaffMember[]; total: number }>('/staff?limit=100');
      return { data: res.data.map(mapStaff), total: res.total };
    },
  });
}

export interface StaffInput {
  email: string;
  firstName: string;
  lastName: string;
  username?: string;
  designation?: string;
  staffGroupId?: number | null;
  password?: string;
}

// API requires `username` and rejects staffGroupId 0/null. The form doesn't
// expose a username, so derive it from the email local-part, and drop an empty
// group selection.
function cleanStaff<T extends Partial<StaffInput>>(data: T): T {
  const out: Partial<StaffInput> = { ...data };
  if (!out.username && out.email) out.username = out.email.split('@')[0];
  if (out.staffGroupId == null || out.staffGroupId === 0) delete out.staffGroupId;
  return out as T;
}

export function useCreateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: StaffInput) => api.post<ApiStaffMember>('/staff', cleanStaff(data)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.staff }),
  });
}

export function useUpdateStaff() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<StaffInput> }) =>
      api.patch<ApiStaffMember>(`/staff/${id}`, cleanStaff(data)),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.staff }),
  });
}

export function useAdminStaffGroups() {
  return useQuery({
    queryKey: adminKeys.staffGroups,
    queryFn: async () => {
      const data = await api.get<ApiStaffGroup[]>('/staff/groups');
      return data.map(mapGroup);
    },
  });
}

export interface StaffGroupInput {
  title: string;
  isAdmin?: boolean;
}

export function useCreateStaffGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: StaffGroupInput) => api.post<ApiStaffGroup>('/staff/groups', data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.staffGroups }),
  });
}

export function useUpdateStaffGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: StaffGroupInput }) =>
      api.patch<ApiStaffGroup>(`/staff/groups/${id}`, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.staffGroups }),
  });
}

// ─── Workflows ───────────────────────────────────────────────────────────────

export function useAdminWorkflows() {
  return useQuery({
    queryKey: adminKeys.workflows,
    queryFn: async () => {
      const data = await api.get<ApiWorkflow[]>('/admin/workflows');
      return data.map(mapWorkflow);
    },
  });
}

export interface WorkflowInput {
  title: string;
  isEnabled?: boolean;
  criteria?: unknown[];
  actions?: unknown[];
}

export function useCreateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: WorkflowInput) => api.post<ApiWorkflow>('/admin/workflows', data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.workflows }),
  });
}

export function useUpdateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: WorkflowInput }) =>
      api.put<ApiWorkflow>(`/admin/workflows/${id}`, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.workflows }),
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/admin/workflows/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.workflows }),
  });
}

// ─── Macro categories ────────────────────────────────────────────────────────

export function useAdminMacroCategories() {
  return useQuery({
    queryKey: adminKeys.macroCategories,
    queryFn: async () => {
      const data = await api.get<ApiMacroCategory[]>('/admin/macro-categories');
      return data.map(mapMacroCategory);
    },
  });
}

export interface MacroCategoryInput {
  title: string;
}

export function useCreateMacroCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: MacroCategoryInput) => api.post<ApiMacroCategory>('/admin/macro-categories', data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.macroCategories }),
  });
}

export function useDeleteMacroCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/admin/macro-categories/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.macroCategories }),
  });
}

// ─── Macros ──────────────────────────────────────────────────────────────────

export function useAdminMacros(categoryId?: number) {
  return useQuery({
    queryKey: adminKeys.macros(categoryId),
    queryFn: async () => {
      const params = new URLSearchParams();
      if (categoryId) params.set('categoryId', String(categoryId));
      const data = await api.get<ApiMacro[]>(`/admin/macros?${params}`);
      return data.map(mapMacro);
    },
  });
}

export interface MacroInput {
  title: string;
  categoryId?: number | null;
  isShared?: boolean;
  actions?: unknown[];
}

export function useCreateMacro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: MacroInput) => api.post<ApiMacro>('/admin/macros', data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.macros() }),
  });
}

export function useUpdateMacro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: MacroInput }) =>
      api.put<ApiMacro>(`/admin/macros/${id}`, data),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.macros() }),
  });
}

export function useDeleteMacro() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/admin/macros/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.macros() }),
  });
}

// ─── Custom field groups & fields ────────────────────────────────────────────

export function useAdminCustomFieldGroups() {
  return useQuery({
    queryKey: adminKeys.customFieldGroups,
    queryFn: async () => {
      // The list response embeds fields inline — there is no per-group GET route
      // (the old per-group fetch always 404'd, so groups showed "0 полей").
      const groups = await api.get<ApiCustomFieldGroup[]>('/admin/custom-field-groups');
      return groups.map((g) => mapFieldGroup(g, g.fields ?? []));
    },
  });
}

export interface CustomFieldGroupInput {
  title: string;
  scope?: 'TICKET' | 'USER' | 'STAFF' | 'ORGANIZATION';
}

export function useCreateCustomFieldGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CustomFieldGroupInput) =>
      // API requires `scope`; default to TICKET when the form doesn't specify one.
      api.post<ApiCustomFieldGroup>('/admin/custom-field-groups', { scope: 'TICKET', ...data }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.customFieldGroups }),
  });
}

export function useDeleteCustomFieldGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/admin/custom-field-groups/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.customFieldGroups }),
  });
}

// API field types are UPPERCASE; the form supplies a human label + lowercase id.
const FIELD_TYPE_MAP: Record<string, string> = {
  text: 'TEXT',
  textarea: 'TEXTAREA',
  password: 'PASSWORD',
  checkbox: 'CHECKBOX',
  radio: 'RADIO',
  select: 'SELECT',
  multiselect: 'MULTISELECT',
  date: 'DATE',
  file: 'FILE',
  custom: 'CUSTOM',
};

export interface CustomFieldInput {
  title: string;
  type: string;
  fieldKey?: string;
  isRequired?: boolean;
  options?: string[];
}

// Derive a valid fieldKey (lowercase alphanumeric/underscore) from the title.
function slugifyFieldKey(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 100) || `field_${Date.now()}`
  );
}

export function useCreateCustomField(groupId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CustomFieldInput) =>
      api.post<ApiCustomField>(`/admin/custom-field-groups/${groupId}/fields`, {
        title: data.title,
        fieldKey: data.fieldKey || slugifyFieldKey(data.title),
        type: FIELD_TYPE_MAP[data.type.toLowerCase()] ?? data.type.toUpperCase(),
        isRequired: data.isRequired ?? false,
        options: data.options ?? [],
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.customFieldGroups }),
  });
}

export function useDeleteCustomField() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.delete<void>(`/admin/custom-fields/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminKeys.customFieldGroups }),
  });
}
