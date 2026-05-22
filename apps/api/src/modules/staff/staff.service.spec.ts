import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { StaffService } from './staff.service';
import type { PrismaService } from '../../prisma/prisma.service';

// We need to spy on hashPassword so we don't need argon2 in tests.
vi.mock('../../auth/password.util', () => ({
  hashPassword: vi.fn().mockResolvedValue('hashed-password'),
  verifyPassword: vi.fn().mockResolvedValue(true),
}));

function makePrismaMock() {
  return {
    staffGroup: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    staff: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    departmentStaff: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  } as unknown as PrismaService;
}

const MOCK_GROUP = {
  id: 1,
  title: 'Support',
  isAdmin: false,
  permissions: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const SAFE_STAFF = {
  id: 1,
  email: 'alice@example.com',
  username: 'alice',
  firstName: 'Alice',
  lastName: 'Smith',
  designation: '',
  signature: '',
  mobileNumber: '',
  timezone: 'UTC',
  isEnabled: true,
  staffGroupId: 1,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('StaffService', () => {
  let service: StaffService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new StaffService(prisma as unknown as PrismaService);
  });

  // ─── listGroups ───────────────────────────────────────────────────────────────

  describe('listGroups', () => {
    it('returns all staff groups ordered by id', async () => {
      (prisma.staffGroup.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_GROUP]);
      const result = await service.listGroups();
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Support');
    });
  });

  // ─── getGroup ─────────────────────────────────────────────────────────────────

  describe('getGroup', () => {
    it('returns the group when found', async () => {
      (prisma.staffGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      const result = await service.getGroup(1);
      expect(result.id).toBe(1);
    });

    it('throws NotFoundException when group not found', async () => {
      (prisma.staffGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getGroup(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── createGroup ──────────────────────────────────────────────────────────────

  describe('createGroup', () => {
    it('creates a new staff group', async () => {
      (prisma.staffGroup.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      const result = await service.createGroup({ title: 'Support' } as any);
      expect(result.title).toBe('Support');
    });
  });

  // ─── updateGroup ──────────────────────────────────────────────────────────────

  describe('updateGroup', () => {
    it('updates group when it exists', async () => {
      (prisma.staffGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      (prisma.staffGroup.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_GROUP,
        title: 'Updated',
      });

      const result = await service.updateGroup(1, { title: 'Updated' } as any);
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when group not found', async () => {
      (prisma.staffGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateGroup(99, { title: 'X' } as any)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── list ─────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns paginated staff list', async () => {
      (prisma.staff.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([SAFE_STAFF]);
      (prisma.staff.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await service.list({ page: 1, limit: 10 } as any);
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('applies groupId filter', async () => {
      (prisma.staff.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.staff.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, groupId: 2 } as any);

      expect(prisma.staff.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ staffGroupId: 2 }) }),
      );
    });

    it('applies enabled filter', async () => {
      (prisma.staff.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.staff.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, enabled: false } as any);

      expect(prisma.staff.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ isEnabled: false }) }),
      );
    });

    it('applies search filter', async () => {
      (prisma.staff.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.staff.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, search: 'alice' } as any);

      expect(prisma.staff.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
      );
    });
  });

  // ─── get ─────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns staff member with group when found', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_STAFF,
        staffGroup: MOCK_GROUP,
      });
      const result = await service.get(1);
      expect(result.id).toBe(1);
      expect(result.staffGroup).toBeDefined();
    });

    it('throws NotFoundException when staff not found', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.get(999)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates a staff member with hashed password', async () => {
      (prisma.staff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.staffGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      (prisma.staff.create as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_STAFF);

      const result = await service.create({
        email: 'alice@example.com',
        username: 'alice',
        password: 'secret123',
        staffGroupId: 1,
        departmentIds: [],
        firstName: 'Alice',
        lastName: 'Smith',
      } as any);

      expect(result.email).toBe('alice@example.com');
      expect(prisma.staff.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: 'hashed-password' }),
        }),
      );
    });

    it('throws ConflictException when email or username already exists', async () => {
      (prisma.staff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_STAFF);

      await expect(
        service.create({
          email: 'alice@example.com',
          username: 'alice',
          password: 'secret',
          staffGroupId: 1,
          departmentIds: [],
        } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when group does not exist', async () => {
      (prisma.staff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.staffGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        service.create({
          email: 'newguy@example.com',
          username: 'newguy',
          password: 'secret',
          staffGroupId: 999,
          departmentIds: [],
        } as any),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates with department associations when departmentIds provided', async () => {
      (prisma.staff.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.staffGroup.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_GROUP);
      (prisma.staff.create as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_STAFF);

      await service.create({
        email: 'bob@example.com',
        username: 'bob',
        password: 'secret',
        staffGroupId: 1,
        departmentIds: [1, 2],
      } as any);

      expect(prisma.staff.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            departments: expect.objectContaining({ create: expect.any(Array) }),
          }),
        }),
      );
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates staff fields', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_STAFF,
        staffGroup: MOCK_GROUP,
      });
      (prisma.staff.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_STAFF,
        firstName: 'Updated',
      });

      const result = await service.update(1, { firstName: 'Updated' } as any);
      expect(result.firstName).toBe('Updated');
    });

    it('hashes password when provided in update', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_STAFF,
        staffGroup: MOCK_GROUP,
      });
      (prisma.staff.update as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_STAFF);

      await service.update(1, { password: 'newpassword' } as any);

      expect(prisma.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: 'hashed-password' }),
        }),
      );
    });

    it('replaces department assignments when departmentIds provided', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_STAFF,
        staffGroup: MOCK_GROUP,
      });
      (prisma.departmentStaff.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.departmentStaff.createMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
      (prisma.staff.update as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_STAFF);

      await service.update(1, { departmentIds: [3, 4] } as any);

      expect(prisma.departmentStaff.deleteMany).toHaveBeenCalledWith({ where: { staffId: 1 } });
      expect(prisma.departmentStaff.createMany).toHaveBeenCalled();
    });

    it('throws NotFoundException when staff not found', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.update(999, { firstName: 'X' } as any)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── disable ─────────────────────────────────────────────────────────────────

  describe('disable', () => {
    it('soft-disables a staff member', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_STAFF,
        staffGroup: MOCK_GROUP,
      });
      (prisma.staff.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_STAFF,
        isEnabled: false,
      });

      const result = await service.disable(1);
      expect(result.isEnabled).toBe(false);
      expect(prisma.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isEnabled: false } }),
      );
    });

    it('throws NotFoundException when staff not found', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.disable(999)).rejects.toThrow(NotFoundException);
    });
  });
});
