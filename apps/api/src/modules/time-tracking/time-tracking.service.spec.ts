import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TimeTrackingService } from './time-tracking.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    timeEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    // E3: create() now verifies the ticket exists first.
    ticket: { findUnique: vi.fn().mockResolvedValue({ id: 10 }) },
  } as unknown as PrismaService;
}

const MOCK_ENTRY = {
  id: 1,
  ticketId: 10,
  staffId: 5,
  minutes: 30,
  note: 'Investigated the issue',
  spentAt: new Date('2026-05-23T10:00:00.000Z'),
  createdAt: new Date('2026-05-23T10:00:00.000Z'),
};

describe('TimeTrackingService', () => {
  let prisma: PrismaService;
  let service: TimeTrackingService;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new TimeTrackingService(prisma);
  });

  it('creates a time entry for the ticket + staff', async () => {
    (prisma.timeEntry.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ENTRY);

    const result = await service.create(10, 5, {
      minutes: 30,
      note: 'Investigated the issue',
      spentAt: '2026-05-23T10:00:00.000Z',
    });

    expect(prisma.timeEntry.create).toHaveBeenCalledWith({
      data: {
        ticketId: 10,
        staffId: 5,
        minutes: 30,
        note: 'Investigated the issue',
        spentAt: new Date('2026-05-23T10:00:00.000Z'),
      },
    });
    expect(result).toEqual(MOCK_ENTRY);
  });

  it('omits spentAt when not provided (lets the DB default apply)', async () => {
    (prisma.timeEntry.create as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ENTRY);

    await service.create(10, 5, { minutes: 15 });

    expect(prisma.timeEntry.create).toHaveBeenCalledWith({
      data: { ticketId: 10, staffId: 5, minutes: 15, note: undefined },
    });
  });

  it('lists entries with staff names', async () => {
    const entries = [{ ...MOCK_ENTRY, staff: { firstName: 'Ada', lastName: 'Lovelace' } }];
    (prisma.timeEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(entries);

    const result = await service.list(10);

    expect(prisma.timeEntry.findMany).toHaveBeenCalledWith({
      where: { ticketId: 10 },
      orderBy: { spentAt: 'desc' },
      include: { staff: { select: { firstName: true, lastName: true } } },
    });
    expect(result.entries).toBe(entries);
  });

  it('sums total minutes across entries', async () => {
    (prisma.timeEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { ...MOCK_ENTRY, minutes: 30 },
      { ...MOCK_ENTRY, id: 2, minutes: 45 },
    ]);

    const result = await service.list(10);

    expect(result.totalMinutes).toBe(75);
  });

  it('returns zero total when there are no entries', async () => {
    (prisma.timeEntry.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await service.list(10);

    expect(result.totalMinutes).toBe(0);
    expect(result.entries).toEqual([]);
  });

  it('deletes an entry owned by the acting staff', async () => {
    (prisma.timeEntry.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ENTRY);
    (prisma.timeEntry.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ENTRY);

    await service.remove(1, MOCK_ENTRY.staffId);

    expect(prisma.timeEntry.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it("throws ForbiddenException when deleting another staff member's entry", async () => {
    (prisma.timeEntry.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ENTRY);

    await expect(service.remove(1, MOCK_ENTRY.staffId + 1)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.timeEntry.delete).not.toHaveBeenCalled();
  });

  it("admin/manager (canManageOthers) can delete another staff member's entry", async () => {
    (prisma.timeEntry.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ENTRY);
    (prisma.timeEntry.delete as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_ENTRY);

    await service.remove(1, MOCK_ENTRY.staffId + 1, true);

    expect(prisma.timeEntry.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });

  it('throws NotFoundException when deleting a missing entry', async () => {
    (prisma.timeEntry.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(service.remove(999, 5)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.timeEntry.delete).not.toHaveBeenCalled();
  });
});
