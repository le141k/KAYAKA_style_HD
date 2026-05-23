import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { LogTimeDto } from './dto';

/** Time tracking: log/list/delete time spent by staff on a ticket. */
@Injectable()
export class TimeTrackingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a time entry for a ticket by the given staff member. */
  create(ticketId: number, staffId: number, dto: LogTimeDto) {
    return this.prisma.timeEntry.create({
      data: {
        ticketId,
        staffId,
        minutes: dto.minutes,
        note: dto.note,
        ...(dto.spentAt ? { spentAt: new Date(dto.spentAt) } : {}),
      },
    });
  }

  /** List all entries for a ticket (newest first) plus the total minutes. */
  async list(ticketId: number) {
    const entries = await this.prisma.timeEntry.findMany({
      where: { ticketId },
      orderBy: { spentAt: 'desc' },
      include: {
        staff: { select: { firstName: true, lastName: true } },
      },
    });
    const totalMinutes = entries.reduce((sum, e) => sum + e.minutes, 0);
    return { entries, totalMinutes };
  }

  /**
   * Delete a single time entry. 404 if missing, 403 if not the owner — unless the
   * caller can manage others (admin / STAFF_MANAGE), so managers can correct the team.
   */
  async remove(id: number, staffId: number, canManageOthers = false) {
    const entry = await this.prisma.timeEntry.findUnique({ where: { id } });
    if (!entry) throw new NotFoundException(`TimeEntry ${id} not found`);
    if (entry.staffId !== staffId && !canManageOthers) {
      throw new ForbiddenException('You can only delete your own time entries');
    }
    await this.prisma.timeEntry.delete({ where: { id } });
  }
}
