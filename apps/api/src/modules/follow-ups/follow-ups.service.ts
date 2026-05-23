import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateFollowUpDto } from './dto';

@Injectable()
export class FollowUpsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a follow-up reminder on a ticket for the given staff member. */
  create(ticketId: number, staffId: number, dto: CreateFollowUpDto) {
    return this.prisma.followUp.create({
      data: {
        ticketId,
        staffId,
        dueAt: new Date(dto.dueAt),
        note: dto.note ?? null,
      },
    });
  }

  /** List follow-ups for a ticket, ordered by due date ascending. */
  listForTicket(ticketId: number) {
    return this.prisma.followUp.findMany({
      where: { ticketId },
      orderBy: { dueAt: 'asc' },
      include: {
        staff: { select: { firstName: true, lastName: true } },
      },
    });
  }

  /** Mark a follow-up complete (or not), updating completedAt accordingly. */
  async setCompleted(id: number, completed: boolean) {
    const existing = await this.prisma.followUp.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Follow-up ${id} not found`);
    }
    return this.prisma.followUp.update({
      where: { id },
      data: {
        completed,
        completedAt: completed ? new Date() : null,
      },
    });
  }

  /** Delete a follow-up. */
  async remove(id: number) {
    const existing = await this.prisma.followUp.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException(`Follow-up ${id} not found`);
    }
    await this.prisma.followUp.delete({ where: { id } });
    return { deleted: true };
  }
}
