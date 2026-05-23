import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { DepartmentsService } from './departments.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    department: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService;
}

const MOCK_DEPT = {
  id: 1,
  title: 'Technical Support',
  type: 'PUBLIC',
  parentId: null,
  displayOrder: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('DepartmentsService', () => {
  let service: DepartmentsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new DepartmentsService(prisma as unknown as PrismaService);
  });

  // ─── listTree ────────────────────────────────────────────────────────────────

  describe('listTree', () => {
    it('returns root departments with nested children', async () => {
      const tree = [{ ...MOCK_DEPT, children: [] }];
      (prisma.department.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(tree);

      const result = await service.listTree();
      expect(result).toHaveLength(1);
      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { parentId: null } }),
      );
    });
  });

  // ─── list ────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns flat department list', async () => {
      (prisma.department.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_DEPT]);
      const result = await service.list();
      expect(result).toHaveLength(1);
    });
  });

  // ─── listPublic ──────────────────────────────────────────────────────────────

  describe('listPublic', () => {
    it('returns only PUBLIC departments with id + title selected', async () => {
      (prisma.department.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: 1, title: 'Technical Support' },
      ]);
      const result = await service.listPublic();
      expect(result).toEqual([{ id: 1, title: 'Technical Support' }]);
      expect(prisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { type: 'PUBLIC' },
          select: { id: true, title: true },
        }),
      );
    });
  });

  // ─── get ─────────────────────────────────────────────────────────────────────

  describe('get', () => {
    it('returns department with children when found', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_DEPT,
        children: [],
      });
      const result = await service.get(1);
      expect(result.id).toBe(1);
      expect(result.children).toBeDefined();
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.get(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── create ──────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates department without parent', async () => {
      (prisma.department.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_DEPT);
      const result = await service.create({ title: 'Technical Support', type: 'PUBLIC' } as any);
      expect(result.title).toBe('Technical Support');
      expect(prisma.department.findUnique).not.toHaveBeenCalled();
    });

    it('validates parent existence when parentId provided', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_DEPT);
      (prisma.department.create as ReturnType<typeof vi.fn>).mockResolvedValue({ ...MOCK_DEPT, parentId: 1 });

      await service.create({ title: 'Sub Dept', type: 'PUBLIC', parentId: 1 } as any);
      expect(prisma.department.findUnique).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when parent not found', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.create({ title: 'Sub', type: 'PUBLIC', parentId: 999 } as any)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── update ──────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates department when found', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_DEPT,
        children: [],
      });
      (prisma.department.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_DEPT,
        title: 'Updated',
      });

      const result = await service.update(1, { title: 'Updated' } as any);
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when department not found', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.update(99, { title: 'X' } as any)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── delete ──────────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('deletes department when found', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_DEPT,
        children: [],
      });
      (prisma.department.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_DEPT);

      await service.delete(1);
      expect(prisma.department.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when department not found', async () => {
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.delete(99)).rejects.toThrow(NotFoundException);
    });
  });
});
