import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  ALL_PERMISSIONS,
  ROLE_PRESETS,
  ROLE_TEMPLATES,
  RBAC_CATALOG,
  PERMISSION_CATALOG,
  isKnownPermission,
  unknownPermissions,
} from './permissions';

describe('permissions catalog', () => {
  it('isKnownPermission recognises catalog keys and rejects others', () => {
    expect(isKnownPermission('ticket.view')).toBe(true);
    expect(isKnownPermission('staff.manage')).toBe(true);
    expect(isKnownPermission('does.not.exist')).toBe(false);
  });

  it('unknownPermissions returns only the keys outside the catalog', () => {
    expect(unknownPermissions(['ticket.view', 'nope', 'staff.manage', 'bad'])).toEqual(['nope', 'bad']);
    expect(unknownPermissions(ALL_PERMISSIONS)).toEqual([]);
  });

  it('PERMISSION_CATALOG covers every permission exactly once', () => {
    const keys = PERMISSION_CATALOG.map((p) => p.key).sort();
    expect(keys).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(keys).size).toBe(ALL_PERMISSIONS.length);
  });
});

describe('role presets', () => {
  it('administrator holds every permission', () => {
    expect(ROLE_PRESETS.administrator).toEqual(ALL_PERMISSIONS);
  });

  it('manager can manage tickets/users/orgs/kb/reports but NOT staff/admin/org-delete', () => {
    const m = ROLE_PRESETS.manager;
    // has
    expect(m).toContain(PERMISSIONS.TICKET_VIEW);
    expect(m).toContain(PERMISSIONS.TICKET_DELETE);
    expect(m).toContain(PERMISSIONS.USER_MANAGE);
    expect(m).toContain(PERMISSIONS.ORG_MANAGE);
    expect(m).toContain(PERMISSIONS.KB_MANAGE);
    expect(m).toContain(PERMISSIONS.REPORT_MANAGE);
    // lacks
    expect(m).not.toContain(PERMISSIONS.STAFF_MANAGE);
    expect(m).not.toContain(PERMISSIONS.ORG_DELETE);
    expect(m).not.toContain(PERMISSIONS.ADMIN_SETTINGS);
    expect(m).not.toContain(PERMISSIONS.ADMIN_SLA);
    expect(m).not.toContain(PERMISSIONS.ADMIN_ALARIS);
    // no admin.* keys at all
    expect(m.some((k) => k.startsWith('admin.'))).toBe(false);
  });

  it('manager is strictly more privileged than agent', () => {
    const agentSet = new Set(ROLE_PRESETS.agent);
    // every agent permission is also a manager permission
    for (const p of ROLE_PRESETS.agent) expect(ROLE_PRESETS.manager).toContain(p);
    // manager adds at least ticket.delete + report.manage + news.manage
    expect(agentSet.has(PERMISSIONS.TICKET_DELETE)).toBe(false);
    expect(ROLE_PRESETS.manager.length).toBeGreaterThan(ROLE_PRESETS.agent.length);
  });

  it('agent cannot manage staff or organizations destructively', () => {
    expect(ROLE_PRESETS.agent).not.toContain(PERMISSIONS.STAFF_MANAGE);
    expect(ROLE_PRESETS.agent).not.toContain(PERMISSIONS.ORG_DELETE);
    expect(ROLE_PRESETS.agent.some((k) => k.startsWith('admin.'))).toBe(false);
  });
});

describe('role templates / RBAC catalog', () => {
  it('exposes exactly the three built-in roles', () => {
    expect(ROLE_TEMPLATES.map((r) => r.key)).toEqual(['administrator', 'manager', 'agent']);
  });

  it('only the administrator template is isAdmin', () => {
    expect(ROLE_TEMPLATES.find((r) => r.key === 'administrator')!.isAdmin).toBe(true);
    expect(ROLE_TEMPLATES.find((r) => r.key === 'manager')!.isAdmin).toBe(false);
    expect(ROLE_TEMPLATES.find((r) => r.key === 'agent')!.isAdmin).toBe(false);
  });

  it('every template lists only known permissions', () => {
    for (const tpl of ROLE_TEMPLATES) expect(unknownPermissions(tpl.permissions)).toEqual([]);
  });

  it('RBAC_CATALOG bundles the catalog + templates', () => {
    expect(RBAC_CATALOG.permissions).toBe(PERMISSION_CATALOG);
    expect(RBAC_CATALOG.roles).toBe(ROLE_TEMPLATES);
  });
});
