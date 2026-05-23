import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { SavedViewsService } from './saved-views.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    savedView: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService;
}

const STAFF_A = 1;
const STAFF_B = 2;

const MOCK_VIEW = {
  id: 10,
  staffId: STAFF_A,
  name: 'Urgent open',
  filters: { status: 'open', priority: 'urgent' },
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('SavedViewsService', () => {
  let prisma: PrismaService;
  let service: SavedViewsService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new SavedViewsService(prisma);
  });

  describe('list', () => {
    it('returns only the current staff’s views ordered by name', async () => {
      (prisma.savedView.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_VIEW]);

      const result = await service.list(STAFF_A);

      expect(prisma.savedView.findMany).toHaveBeenCalledWith({
        where: { staffId: STAFF_A },
        orderBy: { name: 'asc' },
      });
      expect(result).toEqual([MOCK_VIEW]);
    });
  });

  describe('create', () => {
    it('creates a view for the current staff with its filters', async () => {
      (prisma.savedView.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_VIEW);

      const filters = { status: 'open', departmentId: 3 };
      const result = await service.create(STAFF_A, { name: 'My view', filters });

      expect(prisma.savedView.create).toHaveBeenCalledWith({
        data: { staffId: STAFF_A, name: 'My view', filters },
      });
      expect(result).toEqual(MOCK_VIEW);
    });
  });

  describe('delete', () => {
    it('deletes a view owned by the current staff', async () => {
      (prisma.savedView.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_VIEW);

      await service.delete(STAFF_A, MOCK_VIEW.id);

      expect(prisma.savedView.findFirst).toHaveBeenCalledWith({
        where: { id: MOCK_VIEW.id, staffId: STAFF_A },
      });
      expect(prisma.savedView.delete).toHaveBeenCalledWith({ where: { id: MOCK_VIEW.id } });
    });

    it('throws NotFound and does not delete when the view belongs to another staff', async () => {
      // Owner-scoped lookup misses → another staff cannot delete it.
      (prisma.savedView.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.delete(STAFF_B, MOCK_VIEW.id)).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.savedView.findFirst).toHaveBeenCalledWith({
        where: { id: MOCK_VIEW.id, staffId: STAFF_B },
      });
      expect(prisma.savedView.delete).not.toHaveBeenCalled();
    });
  });
});
