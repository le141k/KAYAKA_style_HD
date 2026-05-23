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
