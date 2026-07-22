/**
 * Frontend mirror of the backend RBAC keys (apps/api/src/auth/permissions.ts).
 * The server is authoritative — every API call is still permission-checked there.
 * These are used only to make the UI permission-aware (show/hide nav + screens)
 * so a Manager sees what they can actually use instead of everything being gated
 * behind a single `isAdmin` flag.
 */
export const PERMISSIONS = {
  TICKET_VIEW: 'ticket.view',
  TICKET_CREATE: 'ticket.create',
  TICKET_REPLY: 'ticket.reply',
  TICKET_EDIT: 'ticket.edit',
  TICKET_ASSIGN: 'ticket.assign',
  TICKET_DELETE: 'ticket.delete',
  TICKET_MERGE: 'ticket.merge',
  TICKET_NOTE: 'ticket.note',
  KB_VIEW: 'kb.view',
  KB_MANAGE: 'kb.manage',
  NEWS_MANAGE: 'news.manage',
  USER_MANAGE: 'user.manage',
  STAFF_MANAGE: 'staff.manage',
  ORG_MANAGE: 'org.manage',
  ORG_DELETE: 'org.delete',
  REPORT_RUN: 'report.run',
  REPORT_MANAGE: 'report.manage',
  ADMIN_SETTINGS: 'admin.settings',
  ADMIN_SLA: 'admin.sla',
  ADMIN_WORKFLOW: 'admin.workflow',
  MAIL_VIEW: 'mail.view',
  MAIL_REPLAY: 'mail.replay',
  MAIL_RECONCILE: 'mail.reconcile',
  MAIL_CONFIGURE: 'mail.configure',
  ADMIN_DEPARTMENTS: 'admin.departments',
  ADMIN_CUSTOMFIELDS: 'admin.customfields',
  ADMIN_ALARIS: 'admin.alaris',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Which permission each `/admin` tab requires. Drives both the admin-area gate
 * (may this user open /admin at all?) and the visible tab list.
 */
export const ADMIN_TAB_PERMISSIONS: Record<string, PermissionKey> = {
  '/admin/departments': PERMISSIONS.ADMIN_DEPARTMENTS,
  '/admin/statuses': PERMISSIONS.ADMIN_SETTINGS,
  '/admin/ticket-types': PERMISSIONS.ADMIN_SETTINGS,
  '/admin/sla': PERMISSIONS.ADMIN_SLA,
  '/admin/workflows': PERMISSIONS.ADMIN_WORKFLOW,
  '/admin/staff': PERMISSIONS.STAFF_MANAGE,
  '/admin/custom-fields': PERMISSIONS.ADMIN_CUSTOMFIELDS,
  '/admin/mail': PERMISSIONS.MAIL_VIEW,
  '/admin/alaris': PERMISSIONS.ADMIN_ALARIS,
};

/** The set of permissions that grant access to at least one `/admin` screen. */
export const ADMIN_AREA_PERMISSIONS: PermissionKey[] = Array.from(
  new Set(Object.values(ADMIN_TAB_PERMISSIONS)),
);

/**
 * Permissions that mark an account as "manager-class" (elevated beyond a plain
 * agent) for the purpose of the cosmetic role label. Functional gating always
 * uses the concrete permission checks above, never this label.
 */
const MANAGER_SIGNAL_PERMISSIONS: string[] = [
  PERMISSIONS.STAFF_MANAGE,
  PERMISSIONS.REPORT_MANAGE,
  PERMISSIONS.NEWS_MANAGE,
  PERMISSIONS.TICKET_DELETE,
  PERMISSIONS.ORG_DELETE,
  ...ADMIN_AREA_PERMISSIONS,
];

export type StaffRole = 'admin' | 'manager' | 'agent';

/** Derive a display role from the principal's admin flag + permission set. */
export function deriveRole(isAdmin: boolean, permissions: readonly string[] = []): StaffRole {
  if (isAdmin) return 'admin';
  return permissions.some((p) => MANAGER_SIGNAL_PERMISSIONS.includes(p)) ? 'manager' : 'agent';
}

export const ROLE_LABEL: Record<StaffRole, string> = {
  admin: 'Администратор',
  manager: 'Менеджер',
  agent: 'Агент',
};

export function hasPermission(
  principal: { isAdmin?: boolean; permissions?: readonly string[] } | null | undefined,
  perm: string,
): boolean {
  if (!principal) return false;
  if (principal.isAdmin) return true; // admins inherit everything (matches backend guard)
  return (principal.permissions ?? []).includes(perm);
}

export function hasAnyPermission(
  principal: { isAdmin?: boolean; permissions?: readonly string[] } | null | undefined,
  perms: readonly string[],
): boolean {
  if (!principal) return false;
  if (principal.isAdmin) return true;
  const owned = new Set(principal.permissions ?? []);
  return perms.some((p) => owned.has(p));
}
