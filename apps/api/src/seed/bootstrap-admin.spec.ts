import { describe, expect, it, vi } from 'vitest';
import { bootstrapAdmin, ensureStandardGroups } from './bootstrap-admin';
import { hashPassword } from '../auth/password.util';

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

  it('fails explicitly when supplied credentials are incomplete, invalid, or weak', async () => {
    await expect(
      bootstrapAdmin({ TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com' }, makeDb() as never),
    ).rejects.toThrow('Both bootstrap administrator credentials');
    await expect(
      bootstrapAdmin(
        {
          TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL: 'admin@',
          TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD: 'a-strong-password',
        },
        makeDb() as never,
      ),
    ).rejects.toThrow('email is invalid');
    await expect(
      bootstrapAdmin(
        {
          TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
          TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD: '            ',
        },
        makeDb() as never,
      ),
    ).rejects.toThrow('password is too weak');
  });

  it('normalizes the email but preserves the exact password bytes', async () => {
    const db = makeDb();
    db.staff.findUnique.mockResolvedValue(null);
    db.staff.create.mockResolvedValue({ id: 42 });
    const hashPasswordMock = vi.mocked(hashPassword);
    hashPasswordMock.mockClear();

    await bootstrapAdmin(
      {
        TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL: '  Admin@Example.com  ',
        TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD: '  strong-password-123  ',
      },
      db as never,
    );

    expect(hashPasswordMock).toHaveBeenCalledWith('  strong-password-123  ');
    expect(db.staff.findUnique).toHaveBeenNthCalledWith(1, { where: { email: 'Admin@Example.com' } });
  });
});
