import { describe, expect, it, vi } from 'vitest';
import { bootstrapAdmin, ensureStandardGroups } from './bootstrap-admin';

vi.mock('../auth/password.util', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed-password'),
}));

function makeDb() {
  let nextId = 1;
  return {
    staffGroup: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: nextId++, ...data })),
    },
    staff: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  };
}

describe('bootstrapAdmin', () => {
  it('creates all standard role groups even when bootstrap credentials are absent', async () => {
    const db = makeDb();

    await bootstrapAdmin({}, db as never);

    expect(db.staffGroup.create).toHaveBeenCalledTimes(3);
    expect(db.staff.create).not.toHaveBeenCalled();
  });

  it('matches Administrator by both title and isAdmin, never selecting a same-title non-admin group', async () => {
    const db = makeDb();

    await ensureStandardGroups(db as never);

    expect(db.staffGroup.findFirst).toHaveBeenNthCalledWith(1, {
      where: { title: 'Administrator', isAdmin: true },
    });
    expect(db.staffGroup.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ title: 'Administrator', isAdmin: true }) }),
    );
  });

  it('does not overwrite an existing standard group', async () => {
    const db = makeDb();
    db.staffGroup.findFirst.mockImplementation(
      async ({ where }: { where: { title: string; isAdmin: boolean } }) => ({
        id: where.title === 'Administrator' ? 10 : where.title === 'Manager' ? 11 : 12,
        title: where.title,
        isAdmin: where.isAdmin,
        permissions: ['operator-customized'],
      }),
    );

    await ensureStandardGroups(db as never);

    expect(db.staffGroup.create).not.toHaveBeenCalled();
  });
});
