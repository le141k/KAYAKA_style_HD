/**
 * RBAC permission catalog — replaces Kayako's ~250-key `swstaffgroupsettings` EAV
 * with a typed, code-defined set. Staff groups hold a subset of these keys.
 */
export const PERMISSIONS = {
  // tickets
  TICKET_VIEW: 'ticket.view',
  TICKET_CREATE: 'ticket.create',
  TICKET_REPLY: 'ticket.reply',
  TICKET_EDIT: 'ticket.edit',
  TICKET_ASSIGN: 'ticket.assign',
  TICKET_DELETE: 'ticket.delete',
  TICKET_MERGE: 'ticket.merge',
  TICKET_NOTE: 'ticket.note',
  // knowledgebase
  KB_VIEW: 'kb.view',
  KB_MANAGE: 'kb.manage',
  // news
  NEWS_MANAGE: 'news.manage',
  // people
  USER_MANAGE: 'user.manage',
  STAFF_MANAGE: 'staff.manage',
  ORG_MANAGE: 'org.manage',
  // admin / config
  ADMIN_SETTINGS: 'admin.settings',
  ADMIN_SLA: 'admin.sla',
  ADMIN_WORKFLOW: 'admin.workflow',
  ADMIN_MAIL: 'admin.mail',
  ADMIN_DEPARTMENTS: 'admin.departments',
  ADMIN_CUSTOMFIELDS: 'admin.customfields',
  ADMIN_ALARIS: 'admin.alaris',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Default permission sets for seeded staff groups. */
export const ROLE_PRESETS = {
  administrator: ALL_PERMISSIONS,
  agent: [
    PERMISSIONS.TICKET_VIEW,
    PERMISSIONS.TICKET_CREATE,
    PERMISSIONS.TICKET_REPLY,
    PERMISSIONS.TICKET_EDIT,
    PERMISSIONS.TICKET_ASSIGN,
    PERMISSIONS.TICKET_MERGE,
    PERMISSIONS.TICKET_NOTE,
    PERMISSIONS.KB_VIEW,
    PERMISSIONS.KB_MANAGE,
    PERMISSIONS.USER_MANAGE,
    PERMISSIONS.ORG_MANAGE,
  ] as Permission[],
};
