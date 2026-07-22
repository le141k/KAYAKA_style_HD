import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { LogTimeDto } from './dto';
import { TicketAccessPolicy, type TicketAccessActor } from '../tickets/ticket-access-policy.service';

/** Time tracking: log/list/delete time spent by staff on a ticket. */
@Injectable()
export class TimeTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly ticketAccess?: TicketAccessPolicy,
  ) {}

  /** Create a time entry for a ticket by the given staff member. */
  async create(ticketId: number, staffId: number, dto: LogTimeDto, actor?: TicketAccessActor) {
    const data = {
      ticketId,
      staffId,
      minutes: dto.minutes,
      note: dto.note,
      ...(dto.spentAt ? { spentAt: new Date(dto.spentAt) } : {}),
    };
    if (actor) {
      return this.prisma.$transaction(async (tx) => {
        await this.requireTicketAccess(actor).fenceTicketMutation(tx, actor, ticketId, new Date());
        return tx.timeEntry.create({ data });
      });
    }
    // E3: 404 on a non-existent ticket instead of an opaque FK 500.
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId }, select: { id: true } });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);
    return this.prisma.timeEntry.create({ data });
  }

  /** List all entries for a ticket (newest first) plus the total minutes. */
  async list(ticketId: number, actor?: TicketAccessActor) {
    if (actor) await this.requireTicketAccess(actor).assertCanAccessTicket(actor, ticketId);
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
  async remove(id: number, staffId: number, canManageOthers = false, actor?: TicketAccessActor) {
    const remove = async (db: PrismaService) => {
      const entry = await db.timeEntry.findUnique({ where: { id } });
      if (!entry) throw new NotFoundException(`TimeEntry ${id} not found`);
      if (entry.staffId !== staffId && !canManageOthers) {
        throw new ForbiddenException('You can only delete your own time entries');
      }
      await db.timeEntry.delete({ where: { id } });
    };
    if (actor) {
      await this.prisma.$transaction(async (tx) => {
        const entry = await tx.timeEntry.findUnique({ where: { id } });
        if (!entry) throw new NotFoundException(`TimeEntry ${id} not found`);
        await this.requireTicketAccess(actor).fenceTicketMutation(tx, actor, entry.ticketId, new Date());
        if (entry.staffId !== staffId && !canManageOthers) {
          throw new ForbiddenException('You can only delete your own time entries');
        }
        await tx.timeEntry.delete({ where: { id } });
      });
      return;
    }
    await remove(this.prisma);
  }

  private requireTicketAccess(actor: TicketAccessActor): TicketAccessPolicy {
    if (this.ticketAccess) return this.ticketAccess;
    throw new ServiceUnavailableException(`Ticket access policy is unavailable for staff ${actor.staffId}`);
  }
}
