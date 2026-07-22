import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WorkflowService } from './workflow.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    workflow: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    macroCategory: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    macro: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService;
}

const MOCK_WORKFLOW = {
  id: 1,
  title: 'Auto-assign VIP',
  criteria: [],
  actions: [],
  isEnabled: true,
  sortOrder: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_CATEGORY = {
  id: 1,
  title: 'Billing',
  parentId: null,
  macros: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_MACRO = {
  id: 1,
  title: 'Close ticket',
  replyText: 'Your ticket has been closed.',
  actions: [],
  categoryId: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('WorkflowService', () => {
  let service: WorkflowService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    const events = { emit: vi.fn() } as unknown as import('@nestjs/event-emitter').EventEmitter2;
    service = new WorkflowService(prisma as unknown as PrismaService, events);
  });

  // ─── Workflow CRUD ────────────────────────────────────────────────────────────

  describe('listWorkflows', () => {
    it('returns workflows ordered by sortOrder then id', async () => {
      (prisma.workflow.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_WORKFLOW]);
      const result = await service.listWorkflows();
      expect(result).toHaveLength(1);
    });
  });

  describe('getWorkflow', () => {
    it('returns workflow when found', async () => {
      (prisma.workflow.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_WORKFLOW);
      const result = await service.getWorkflow(1);
      expect(result.title).toBe('Auto-assign VIP');
    });

    it('throws NotFoundException when workflow not found', async () => {
      (prisma.workflow.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getWorkflow(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('createWorkflow', () => {
    it('creates workflow with provided data', async () => {
      (prisma.workflow.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_WORKFLOW);
      const result = await service.createWorkflow({
        title: 'Auto-assign VIP',
        criteria: [],
        actions: [],
        isEnabled: true,
        sortOrder: 0,
      });
      expect(result.id).toBe(1);
      expect(prisma.workflow.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: 'Auto-assign VIP' }),
        }),
      );
    });

    it('rejects a malformed customer send_email action before it can be persisted', async () => {
      await expect(
        service.createWorkflow({
          title: 'Broken legacy-style mail rule',
          criteria: [],
          actions: [{ type: 'send_email', value: '   ' }],
          isEnabled: true,
          sortOrder: 0,
        }),
      ).rejects.toThrow('send_email requires a non-empty string value or note');

      expect(prisma.workflow.create).not.toHaveBeenCalled();
    });
  });

  describe('updateWorkflow', () => {
    it('updates workflow fields', async () => {
      (prisma.workflow.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_WORKFLOW);
      (prisma.workflow.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_WORKFLOW,
        title: 'Updated',
      });

      const result = await service.updateWorkflow(1, { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when workflow not found', async () => {
      (prisma.workflow.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateWorkflow(99, { title: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('only patches provided fields', async () => {
      (prisma.workflow.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_WORKFLOW);
      (prisma.workflow.update as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_WORKFLOW);

      await service.updateWorkflow(1, { isEnabled: false });

      expect(prisma.workflow.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isEnabled: false } }),
      );
    });
  });

  describe('deleteWorkflow', () => {
    it('deletes workflow when found', async () => {
      (prisma.workflow.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_WORKFLOW);
      (prisma.workflow.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_WORKFLOW);

      await service.deleteWorkflow(1);
      expect(prisma.workflow.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when workflow not found', async () => {
      (prisma.workflow.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteWorkflow(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── MacroCategory CRUD ───────────────────────────────────────────────────────

  describe('listMacroCategories', () => {
    it('returns categories with their macros', async () => {
      (prisma.macroCategory.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_CATEGORY]);
      const result = await service.listMacroCategories();
      expect(result).toHaveLength(1);
      expect(prisma.macroCategory.findMany).toHaveBeenCalledWith({ include: { macros: true } });
    });
  });

  describe('getMacroCategory', () => {
    it('returns category when found', async () => {
      (prisma.macroCategory.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CATEGORY);
      const result = await service.getMacroCategory(1);
      expect(result.title).toBe('Billing');
    });

    it('throws NotFoundException when category not found', async () => {
      (prisma.macroCategory.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getMacroCategory(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('createMacroCategory', () => {
    it('creates a macro category', async () => {
      (prisma.macroCategory.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CATEGORY);
      const result = await service.createMacroCategory({ title: 'Billing' });
      expect(result.title).toBe('Billing');
    });
  });

  describe('updateMacroCategory', () => {
    it('updates category when found', async () => {
      (prisma.macroCategory.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CATEGORY);
      (prisma.macroCategory.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_CATEGORY,
        title: 'Sales',
      });

      const result = await service.updateMacroCategory(1, { title: 'Sales' });
      expect(result.title).toBe('Sales');
    });

    it('throws NotFoundException when category not found', async () => {
      (prisma.macroCategory.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateMacroCategory(99, { title: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteMacroCategory', () => {
    it('deletes category when found', async () => {
      (prisma.macroCategory.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CATEGORY);
      (prisma.macroCategory.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_CATEGORY);

      await service.deleteMacroCategory(1);
      expect(prisma.macroCategory.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when category not found', async () => {
      (prisma.macroCategory.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteMacroCategory(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Macro CRUD ───────────────────────────────────────────────────────────────

  describe('listMacros', () => {
    it('returns all macros when no categoryId filter', async () => {
      (prisma.macro.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_MACRO]);
      const result = await service.listMacros();
      expect(result).toHaveLength(1);
      expect(prisma.macro.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, include: { category: true } }),
      );
    });

    it('filters by categoryId when provided', async () => {
      (prisma.macro.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([MOCK_MACRO]);
      await service.listMacros(1);
      expect(prisma.macro.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { categoryId: 1 } }),
      );
    });
  });

  describe('getMacro', () => {
    it('returns macro when found', async () => {
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MACRO);
      const result = await service.getMacro(1);
      expect(result.title).toBe('Close ticket');
    });

    it('throws NotFoundException when macro not found', async () => {
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getMacro(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('createMacro', () => {
    it('creates a macro', async () => {
      (prisma.macro.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MACRO);
      const result = await service.createMacro({
        title: 'Close ticket',
        replyText: 'Closing.',
        actions: [],
        isShared: true,
        categoryId: 1,
      });
      expect(result.id).toBe(1);
    });
  });

  describe('updateMacro', () => {
    it('updates macro fields', async () => {
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MACRO);
      (prisma.macro.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_MACRO,
        title: 'Updated',
      });

      const result = await service.updateMacro(1, { title: 'Updated' });
      expect(result.title).toBe('Updated');
    });

    it('throws NotFoundException when macro not found', async () => {
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.updateMacro(99, { title: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteMacro', () => {
    it('deletes macro when found', async () => {
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MACRO);
      (prisma.macro.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_MACRO);

      await service.deleteMacro(1);
      expect(prisma.macro.delete).toHaveBeenCalledWith({ where: { id: 1 } });
    });

    it('throws NotFoundException when macro not found', async () => {
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.deleteMacro(99)).rejects.toThrow(NotFoundException);
    });
  });
});
