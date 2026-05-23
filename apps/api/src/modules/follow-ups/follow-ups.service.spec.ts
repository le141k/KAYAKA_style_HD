import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { FollowUpsService } from './follow-ups.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    followUp: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  };
}

describe('FollowUpsService', () => {
  let service: FollowUpsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new FollowUpsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('creates a follow-up for the ticket and staff with parsed dueAt', async () => {
      prisma.followUp.create.mockResolvedValue({ id: 1 });
      await service.create(7, 42, { dueAt: '2026-06-01T10:00:00.000Z', note: 'call back' });

      expect(prisma.followUp.create).toHaveBeenCalledWith({
        data: {
          ticketId: 7,
          staffId: 42,
          dueAt: new Date('2026-06-01T10:00:00.000Z'),
          note: 'call back',
        },
      });
    });

    it('stores null note when omitted', async () => {
      prisma.followUp.create.mockResolvedValue({ id: 2 });
      await service.create(7, 42, { dueAt: '2026-06-01T10:00:00.000Z' });

      expect(prisma.followUp.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ note: null }) }),
      );
    });
  });

  describe('listForTicket', () => {
    it('lists follow-ups ordered by dueAt asc including staff names', async () => {
      prisma.followUp.findMany.mockResolvedValue([]);
      await service.listForTicket(7);

      expect(prisma.followUp.findMany).toHaveBeenCalledWith({
        where: { ticketId: 7 },
        orderBy: { dueAt: 'asc' },
        include: { staff: { select: { firstName: true, lastName: true } } },
      });
    });
  });

  describe('setCompleted', () => {
    it('sets completed=true and a completedAt timestamp', async () => {
      prisma.followUp.findUnique.mockResolvedValue({ id: 3, completed: false });
      prisma.followUp.update.mockResolvedValue({ id: 3, completed: true });

      await service.setCompleted(3, true);

      const arg = prisma.followUp.update.mock.calls[0]?.[0] as {
        where: unknown;
        data: { completed: boolean; completedAt: unknown };
      };
      expect(arg.where).toEqual({ id: 3 });
      expect(arg.data.completed).toBe(true);
      expect(arg.data.completedAt).toBeInstanceOf(Date);
    });

    it('clears completedAt when set to incomplete', async () => {
      prisma.followUp.findUnique.mockResolvedValue({ id: 3, completed: true });
      prisma.followUp.update.mockResolvedValue({ id: 3, completed: false });

      await service.setCompleted(3, false);

      expect(prisma.followUp.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { completed: false, completedAt: null },
      });
    });

    it('throws NotFoundException when the follow-up is missing', async () => {
      prisma.followUp.findUnique.mockResolvedValue(null);
      await expect(service.setCompleted(999, true)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.followUp.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('deletes an existing follow-up', async () => {
      prisma.followUp.findUnique.mockResolvedValue({ id: 5 });
      prisma.followUp.delete.mockResolvedValue({ id: 5 });

      const result = await service.remove(5);

      expect(prisma.followUp.delete).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(result).toEqual({ deleted: true });
    });

    it('throws NotFoundException when the follow-up is missing', async () => {
      prisma.followUp.findUnique.mockResolvedValue(null);
      await expect(service.remove(999)).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.followUp.delete).not.toHaveBeenCalled();
    });
  });
});
