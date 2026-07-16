import { describe, it, expect } from 'vitest';
import { UpdateStaffGroupSchema, CreateStaffGroupSchema } from './dto';

describe('UpdateStaffGroupSchema (privilege-escalation guard)', () => {
  it('strips isAdmin from an update payload (cannot escalate a group to admin)', () => {
    const parsed = UpdateStaffGroupSchema.parse({
      title: 'Support',
      isAdmin: true, // attacker tries to escalate
      permissions: ['ticket.view'],
    });
    expect(parsed).not.toHaveProperty('isAdmin');
    expect(parsed.title).toBe('Support');
    expect(parsed.permissions).toEqual(['ticket.view']);
  });

  it('still allows isAdmin on CREATE (admin-gated route, legitimate)', () => {
    const parsed = CreateStaffGroupSchema.parse({ title: 'Admins', isAdmin: true });
    expect(parsed.isAdmin).toBe(true);
  });
});

describe('permission-key validation', () => {
  it('accepts a group with only known permission keys', () => {
    const parsed = CreateStaffGroupSchema.parse({
      title: 'Support',
      permissions: ['ticket.view', 'ticket.reply', 'report.run'],
    });
    expect(parsed.permissions).toContain('ticket.view');
  });

  it('rejects a CREATE with an unknown permission key (→ 400 surface)', () => {
    const result = CreateStaffGroupSchema.safeParse({
      title: 'Bad',
      permissions: ['ticket.view', 'not.a.real.permission'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toMatch(/Unknown permission key/);
    }
  });

  it('rejects an UPDATE with an unknown permission key', () => {
    const result = UpdateStaffGroupSchema.safeParse({ permissions: ['totally.made.up'] });
    expect(result.success).toBe(false);
  });
});
