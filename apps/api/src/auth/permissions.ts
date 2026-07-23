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
  // Deleting an organization detaches all its users (FK SET NULL) — admin-only,
  // deliberately NOT in the agent OR manager preset.
  ORG_DELETE: 'org.delete',
  // reports
  REPORT_RUN: 'report.run',
  REPORT_MANAGE: 'report.manage',
  // admin / config
  ADMIN_SETTINGS: 'admin.settings',
  ADMIN_SLA: 'admin.sla',
  ADMIN_WORKFLOW: 'admin.workflow',
  // Mail operations are intentionally split: observing a queue must not grant the
  // destructive/configuration actions that can discard history or re-deliver mail.
  MAIL_VIEW: 'mail.view',
  MAIL_REPLAY: 'mail.replay',
  // Turning an inert capture into ACCEPTED can create/update a ticket and schedule
  // outbound mail. It is intentionally not bundled with quarantine replay.
  MAIL_PROMOTE_CAPTURED: 'mail.capture.promote',
  MAIL_RECONCILE: 'mail.reconcile',
  MAIL_CONFIGURE: 'mail.configure',
  ADMIN_DEPARTMENTS: 'admin.departments',
  ADMIN_CUSTOMFIELDS: 'admin.customfields',
  ADMIN_ALARIS: 'admin.alaris',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

/** Type-guard / validator used at the boundary (unknown key → 400). */
export function isKnownPermission(key: string): key is Permission {
  return PERMISSION_SET.has(key);
}

/** Return the subset of `keys` that are NOT part of the catalog. */
export function unknownPermissions(keys: readonly string[]): string[] {
  return keys.filter((k) => !PERMISSION_SET.has(k));
}

/**
 * Human-readable catalog grouped by area. `label` is Russian to match the admin
 * UI. Served (with the role templates below) from `GET /api/staff/rbac` so the
 * frontend renders permission pickers and role summaries from a single source of
 * truth instead of a hand-maintained copy.
 */
export type PermissionCategory = 'tickets' | 'knowledgebase' | 'news' | 'people' | 'reports' | 'admin';

export interface PermissionMeta {
  key: Permission;
  label: string;
  category: PermissionCategory;
}

export const PERMISSION_CATALOG: PermissionMeta[] = [
  { key: PERMISSIONS.TICKET_VIEW, label: 'Просмотр заявок', category: 'tickets' },
  { key: PERMISSIONS.TICKET_CREATE, label: 'Создание заявок', category: 'tickets' },
  { key: PERMISSIONS.TICKET_REPLY, label: 'Ответ на заявки', category: 'tickets' },
  { key: PERMISSIONS.TICKET_EDIT, label: 'Редактирование заявок', category: 'tickets' },
  { key: PERMISSIONS.TICKET_ASSIGN, label: 'Назначение заявок', category: 'tickets' },
  { key: PERMISSIONS.TICKET_DELETE, label: 'Удаление заявок', category: 'tickets' },
  { key: PERMISSIONS.TICKET_MERGE, label: 'Слияние заявок', category: 'tickets' },
  { key: PERMISSIONS.TICKET_NOTE, label: 'Заметки', category: 'tickets' },
  { key: PERMISSIONS.KB_VIEW, label: 'База знаний: просмотр', category: 'knowledgebase' },
  { key: PERMISSIONS.KB_MANAGE, label: 'База знаний: управление', category: 'knowledgebase' },
  { key: PERMISSIONS.NEWS_MANAGE, label: 'Новости: управление', category: 'news' },
  { key: PERMISSIONS.USER_MANAGE, label: 'Управление пользователями', category: 'people' },
  { key: PERMISSIONS.STAFF_MANAGE, label: 'Управление сотрудниками', category: 'people' },
  { key: PERMISSIONS.ORG_MANAGE, label: 'Управление организациями', category: 'people' },
  { key: PERMISSIONS.ORG_DELETE, label: 'Удаление организаций', category: 'people' },
  { key: PERMISSIONS.REPORT_RUN, label: 'Запуск отчётов', category: 'reports' },
  { key: PERMISSIONS.REPORT_MANAGE, label: 'Управление отчётами', category: 'reports' },
  { key: PERMISSIONS.ADMIN_SETTINGS, label: 'Настройки (статусы, приоритеты…)', category: 'admin' },
  { key: PERMISSIONS.ADMIN_SLA, label: 'SLA', category: 'admin' },
  { key: PERMISSIONS.ADMIN_WORKFLOW, label: 'Правила и макросы', category: 'admin' },
  { key: PERMISSIONS.MAIL_VIEW, label: 'Почта: просмотр состояния и карантина', category: 'admin' },
  { key: PERMISSIONS.MAIL_REPLAY, label: 'Почта: повтор карантинных писем', category: 'admin' },
  {
    key: PERMISSIONS.MAIL_PROMOTE_CAPTURED,
    label: 'Почта: передать захваченное письмо в обработку',
    category: 'admin',
  },
  { key: PERMISSIONS.MAIL_RECONCILE, label: 'Почта: реконсиляция IMAP', category: 'admin' },
  { key: PERMISSIONS.MAIL_CONFIGURE, label: 'Почта: настройка очередей и правил', category: 'admin' },
  { key: PERMISSIONS.ADMIN_DEPARTMENTS, label: 'Отделы', category: 'admin' },
  { key: PERMISSIONS.ADMIN_CUSTOMFIELDS, label: 'Пользовательские поля', category: 'admin' },
  { key: PERMISSIONS.ADMIN_ALARIS, label: 'Интеграция Alaris', category: 'admin' },
];

/**
 * Manager preset — full ticket handling plus people/org/KB/report management,
 * but deliberately WITHOUT `staff.manage`, `org.delete`, or any `admin.*` system
 * configuration key. A Manager runs the front line; an Administrator owns RBAC
 * and product configuration.
 */
const MANAGER_PERMISSIONS: Permission[] = [
  PERMISSIONS.TICKET_VIEW,
  PERMISSIONS.TICKET_CREATE,
  PERMISSIONS.TICKET_REPLY,
  PERMISSIONS.TICKET_EDIT,
  PERMISSIONS.TICKET_ASSIGN,
  PERMISSIONS.TICKET_DELETE,
  PERMISSIONS.TICKET_MERGE,
  PERMISSIONS.TICKET_NOTE,
  PERMISSIONS.KB_VIEW,
  PERMISSIONS.KB_MANAGE,
  PERMISSIONS.NEWS_MANAGE,
  PERMISSIONS.USER_MANAGE,
  PERMISSIONS.ORG_MANAGE,
  PERMISSIONS.REPORT_RUN,
  PERMISSIONS.REPORT_MANAGE,
  // Operational visibility only. A manager can diagnose an incoming-mail outage,
  // but cannot replay/reconcile or alter routing without an explicit grant.
  PERMISSIONS.MAIL_VIEW,
];

const AGENT_PERMISSIONS: Permission[] = [
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
  PERMISSIONS.REPORT_RUN,
];

/** Default permission sets for seeded staff groups. */
export const ROLE_PRESETS = {
  administrator: ALL_PERMISSIONS,
  manager: MANAGER_PERMISSIONS,
  agent: AGENT_PERMISSIONS,
};

/** Stable identifiers for the three built-in roles. */
export type RoleKey = 'administrator' | 'manager' | 'agent';

export interface RoleTemplate {
  key: RoleKey;
  title: string;
  description: string;
  isAdmin: boolean;
  permissions: Permission[];
}

/**
 * Built-in role templates. These drive:
 *  - the standard groups created by the seed / prod bootstrap,
 *  - the "start from a template" option in the group-create UI,
 *  - the role summary shown when creating a staff member.
 *
 * They are TEMPLATES, not the live groups: an operator may tune a group's
 * permissions afterwards and the seed/bootstrap will not overwrite them.
 */
export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'administrator',
    title: 'Administrator',
    description: 'Полное администрирование продукта и RBAC. Обходит проверки отдельных прав.',
    isAdmin: true,
    permissions: ROLE_PRESETS.administrator,
  },
  {
    key: 'manager',
    title: 'Manager',
    description:
      'Управление тикетами, пользователями, организациями, базой знаний и отчётами. ' +
      'Без управления сотрудниками (staff.manage) и системных прав admin.*.',
    isAdmin: false,
    permissions: ROLE_PRESETS.manager,
  },
  {
    key: 'agent',
    title: 'Agent',
    description:
      'Обработка тикетов, просмотр и ведение базы знаний, запуск отчётов. ' +
      'Без управления сотрудниками, удаления организаций и системной конфигурации.',
    isAdmin: false,
    permissions: ROLE_PRESETS.agent,
  },
];

/** The RBAC catalog payload returned by `GET /api/staff/rbac`. */
export interface RbacCatalog {
  permissions: PermissionMeta[];
  roles: RoleTemplate[];
}

export const RBAC_CATALOG: RbacCatalog = {
  permissions: PERMISSION_CATALOG,
  roles: ROLE_TEMPLATES,
};
