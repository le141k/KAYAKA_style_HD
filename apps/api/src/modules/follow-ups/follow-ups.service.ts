import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

  /** Mark a follow-up complete (or not). 404 if missing, 403 if not the owner. */
  async setCompleted(id: number, completed: boolean, staffId: number) {
    await this.assertOwned(id, staffId);
    return this.prisma.followUp.update({
      where: { id },
      data: {
        completed,
        completedAt: completed ? new Date() : null,
      },
    });
  }

  /** Delete a follow-up. 404 if missing, 403 if not the owner. */
  async remove(id: number, staffId: number) {
    await this.assertOwned(id, staffId);
    await this.prisma.followUp.delete({ where: { id } });
    return { deleted: true };
  }

  /** Ensure the follow-up exists and belongs to the acting staff member. */
  private async assertOwned(id: number, staffId: number): Promise<void> {
    const existing = await this.prisma.followUp.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Follow-up ${id} not found`);
    if (existing.staffId !== staffId) {
      throw new ForbiddenException('You can only modify your own follow-ups');
    }
  }
}
