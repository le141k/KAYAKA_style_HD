import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { OrganizationsService } from './organizations.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AdminService } from '../admin/admin.service';

function makePrismaMock() {
  return {
    organization: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService;
}

const MOCK_ORG = {
  id: 1,
  name: 'Acme Corp',
  city: 'Kyiv',
  country: 'UA',
  phone: null,
  website: null,
  notes: null,
  customFields: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeAdminMock(): AdminService {
  return {
    validateCustomFields: vi.fn().mockResolvedValue(undefined),
    encryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
    decryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
    decryptCustomFieldsMany: vi
      .fn()
      .mockImplementation((_s: unknown, rows: unknown) => Promise.resolve(rows)),
  } as unknown as AdminService;
}

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let adminMock: AdminService;

  beforeEach(() => {
    prisma = makePrismaMock();
    adminMock = makeAdminMock();
    service = new OrganizationsService(prisma as unknown as PrismaService, adminMock);
  });

  // ─── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns paginated organizations with total', async () => {
      (prisma.organization.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_ORG]);
      (prisma.organization.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await service.list({ page: 1, limit: 10 } as any);
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(prisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 10 }),
      );
    });

    it('applies search filter across name/city/country', async () => {
      (prisma.organization.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.organization.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 10, search: 'acme' } as any);

      expect(prisma.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
      );
    });

    it('passes empty where when no search provided', async () => {
      (prisma.organization.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.organization.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 1, limit: 5 } as any);

      expect(prisma.organization.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
    });

    it('computes skip based on page', async () => {
      (prisma.organization.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.organization.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.list({ page: 2, limit: 5 } as any);
      expect(prisma.organization.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 5 }));
    });
  });

  // ─── get ─────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns organization when found', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);
      const result = await service.get(1);
      expect(result.name).toBe('Acme Corp');
    });

    it('throws NotFoundException when org not found', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.get(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates and returns new organization', async () => {
      (prisma.organization.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);
      const result = await service.create({ name: 'Acme Corp' } as any);
      expect(result.name).toBe('Acme Corp');
    });

    it('calls validateCustomFields with ORGANIZATION scope when customFields provided', async () => {
      (prisma.organization.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);

      await service.create({ name: 'Acme Corp', customFields: { region: 'EU' } } as any);

      expect(adminMock.validateCustomFields).toHaveBeenCalledWith('ORGANIZATION', { region: 'EU' });
    });

    it('throws BadRequestException when validateCustomFields rejects on create', async () => {
      (adminMock.validateCustomFields as ReturnType<typeof vi.fn>).mockRejectedValue(
        new BadRequestException('Custom field "region" is required'),
      );

      await expect(service.create({ name: 'Acme Corp', customFields: {} } as any)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates organization when found', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);
      (prisma.organization.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_ORG,
        name: 'Updated',
      });

      const result = await service.update(1, { name: 'Updated' } as any);
      expect(result.name).toBe('Updated');
    });

    it('throws NotFoundException when org not found', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.update(99, { name: 'X' } as any)).rejects.toThrow(NotFoundException);
    });

    it('calls validateCustomFields with ORGANIZATION scope when customFields provided on update', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);
      (prisma.organization.update as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);

      await service.update(1, { customFields: { region: 'APAC' } } as any);

      expect(adminMock.validateCustomFields).toHaveBeenCalledWith('ORGANIZATION', { region: 'APAC' });
    });

    it('throws BadRequestException when validateCustomFields rejects on update', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);
      (adminMock.validateCustomFields as ReturnType<typeof vi.fn>).mockRejectedValue(
        new BadRequestException('Custom field "region" is required'),
      );

      await expect(service.update(1, { customFields: {} } as any)).rejects.toThrow(BadRequestException);
    });
  });

  // ─── delete ──────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes organization when found', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);
      (prisma.organization.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ORG);

      await service.delete(1);
      expect(prisma.organization.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when org not found', async () => {
      (prisma.organization.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.delete(99)).rejects.toThrow(NotFoundException);
    });
  });
});
