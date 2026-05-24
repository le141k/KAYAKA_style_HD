import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { UsersService } from './users.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AdminService } from '../admin/admin.service';

function makePrismaMock() {
  return {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    userEmail: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    $transaction: vi.fn(),
  } as unknown as PrismaService;
}

const SAFE_USER = {
  id: 1,
  fullName: 'Jane Doe',
  phone: null,
  designation: null,
  isEnabled: true,
  isValidated: true,
  timezone: 'UTC',
  userGroupId: null,
  organizationId: null,
  geoip: null,
  customFields: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  emails: [{ id: 1, userId: 1, email: 'jane@example.com', isPrimary: true, createdAt: new Date() }],
};

function makeAdminMock(): AdminService {
  return {
    validateCustomFields: vi.fn().mockResolvedValue(undefined),
    encryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
    decryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
  } as unknown as AdminService;
}

describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let adminMock: AdminService;

  beforeEach(() => {
    prisma = makePrismaMock();
    adminMock = makeAdminMock();
    service = new UsersService(prisma as unknown as PrismaService, adminMock);
  });

  // ─── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns paginated data and total', async () => {
      (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([SAFE_USER]);
      (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await service.list({ page: 1, limit: 10 } as any);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0, take: 10 }));
    });

    it('applies search filter', async () => {
      (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, search: 'jane' } as any);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
      );
    });

    it('applies email filter', async () => {
      (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, email: 'jane@example.com' } as any);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ emails: expect.any(Object) }) }),
      );
    });

    it('applies organizationId filter', async () => {
      (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 5, organizationId: 42 } as any);

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organizationId: 42 }) }),
      );
    });

    it('uses page offset correctly', async () => {
      (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.user.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 3, limit: 10 } as any);

      expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
    });
  });

  // ─── get ─────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns user when found', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);
      const result = await service.get(1);
      expect(result.id).toBe(1);
    });

    it('throws NotFoundException when user is not found', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.get(999)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── findByEmail ─────────────────────────────────────────────────────────────

  describe('findByEmail', () => {
    it('returns the user when email exists', async () => {
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ user: SAFE_USER });
      const result = await service.findByEmail('jane@example.com');
      expect(result).toEqual(SAFE_USER);
    });

    it('returns null when email is not found', async () => {
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const result = await service.findByEmail('nobody@example.com');
      expect(result).toBeNull();
    });
  });

  // ─── findOrCreate ─────────────────────────────────────────────────────────────

  describe('findOrCreate', () => {
    it('returns existing user if email is already registered', async () => {
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ user: SAFE_USER });
      const result = await service.findOrCreate('jane@example.com', 'Jane Doe');
      expect(result.id).toBe(1);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates a new user if email is not found', async () => {
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_USER,
        fullName: 'New User',
      });

      const result = await service.findOrCreate('new@example.com', 'New User');
      expect(result.fullName).toBe('New User');
      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ fullName: 'New User' }),
        }),
      );
    });
  });

  // ─── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates user with primary email and additional emails', async () => {
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);

      const result = await service.create({
        primaryEmail: 'jane@example.com',
        fullName: 'Jane Doe',
        additionalEmails: ['jane2@example.com'],
      } as any);

      expect(result.id).toBe(1);
      expect(prisma.user.create).toHaveBeenCalled();
    });

    it('throws ConflictException if primary email is already in use', async () => {
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 5 });

      await expect(
        service.create({
          primaryEmail: 'taken@example.com',
          fullName: 'Somebody',
          additionalEmails: [],
        } as any),
      ).rejects.toThrow(ConflictException);
    });

    it('calls validateCustomFields with USER scope when customFields provided', async () => {
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.user.create as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);

      await service.create({
        primaryEmail: 'jane@example.com',
        fullName: 'Jane Doe',
        additionalEmails: [],
        customFields: { account_number: 'ACC-123' },
      } as any);

      expect(adminMock.validateCustomFields).toHaveBeenCalledWith('USER', { account_number: 'ACC-123' });
    });

    it('throws BadRequestException when validateCustomFields rejects (create)', async () => {
      (adminMock.validateCustomFields as ReturnType<typeof vi.fn>).mockRejectedValue(
        new BadRequestException('Custom field "account_number" is required'),
      );

      await expect(
        service.create({
          primaryEmail: 'jane@example.com',
          fullName: 'Jane Doe',
          additionalEmails: [],
          customFields: {},
        } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates user fields', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);
      (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...SAFE_USER,
        fullName: 'Updated',
      });

      const result = await service.update(1, { fullName: 'Updated' } as any);
      expect(result.fullName).toBe('Updated');
    });

    it('throws NotFoundException if user does not exist', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.update(999, { fullName: 'X' } as any)).rejects.toThrow(NotFoundException);
    });

    it('calls validateCustomFields with USER scope when customFields provided on update', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);
      (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);

      await service.update(1, { customFields: { account_number: 'ACC-456' } } as any);

      expect(adminMock.validateCustomFields).toHaveBeenCalledWith('USER', { account_number: 'ACC-456' });
    });

    it('throws BadRequestException when validateCustomFields rejects (update)', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);
      (adminMock.validateCustomFields as ReturnType<typeof vi.fn>).mockRejectedValue(
        new BadRequestException('Custom field "account_number" is required'),
      );

      await expect(service.update(1, { customFields: {} } as any)).rejects.toThrow(BadRequestException);
    });
  });

  // ─── addEmail ────────────────────────────────────────────────────────────────

  describe('addEmail', () => {
    it('adds a new non-primary email', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.userEmail.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 2 });

      const result = await service.addEmail(1, { email: 'jane2@example.com', isPrimary: false });
      expect(result.id).toBe(2);
      expect(prisma.userEmail.updateMany).not.toHaveBeenCalled();
    });

    it('demotes existing primary when adding a new primary email', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.userEmail.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.userEmail.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 3 });

      await service.addEmail(1, { email: 'newprimary@example.com', isPrimary: true });
      expect(prisma.userEmail.updateMany).toHaveBeenCalled();
    });

    it('throws ConflictException if email already in use', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(SAFE_USER);
      (prisma.userEmail.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 99 });

      await expect(service.addEmail(1, { email: 'taken@example.com', isPrimary: false })).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws NotFoundException if user not found', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.addEmail(999, { email: 'x@example.com', isPrimary: false })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── setPrimaryEmail ─────────────────────────────────────────────────────────

  describe('setPrimaryEmail', () => {
    it('sets the email as primary via transaction', async () => {
      (prisma.userEmail.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 2,
        userId: 1,
        isPrimary: false,
      });
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await service.setPrimaryEmail(1, 2);
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('throws NotFoundException if email record not found for user', async () => {
      (prisma.userEmail.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.setPrimaryEmail(1, 99)).rejects.toThrow(NotFoundException);
    });
  });
});
