import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthStaff } from '../../auth/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * The part of an authenticated staff principal relevant to ticket department
 * isolation.  Keeping this narrow makes it impossible for a caller to turn a
 * permission into a department-scope bypass accidentally.
 */
export type TicketAccessActor = Pick<AuthStaff, 'staffId' | 'isAdmin'>;

export interface TicketDepartmentScope {
  /** Administrators and staff without DepartmentStaff rows can see every department. */
  unrestricted: boolean;
  departmentIds: number[];
}

/**
 * One authoritative policy for every staff-facing ticket boundary.
 *
 * A DepartmentStaff row is an allow-list.  Its absence deliberately keeps the
 * historic "all departments" behaviour for unrestricted staff; it is not a
 * deny-all state.  Ticket lookups use a scoped SQL predicate instead of reading
 * a row first and filtering it in application code, so unauthorized callers do
 * not receive ticket/post/note data while the page is being assembled.
 */
@Injectable()
export class TicketAccessPolicy {
  constructor(private readonly prisma: PrismaService) {}

  async resolveScope(actor: TicketAccessActor): Promise<TicketDepartmentScope> {
    if (actor.isAdmin) return { unrestricted: true, departmentIds: [] };

    const rows = await this.prisma.departmentStaff.findMany({
      where: { staffId: actor.staffId },
      select: { departmentId: true },
    });
    const departmentIds = [...new Set(rows.map((row) => row.departmentId))];
    return { unrestricted: departmentIds.length === 0, departmentIds };
  }

  async ticketWhere(actor: TicketAccessActor): Promise<Prisma.TicketWhereInput> {
    return this.ticketWhereForScope(await this.resolveScope(actor));
  }

  ticketWhereForScope(scope: TicketDepartmentScope): Prisma.TicketWhereInput {
    return scope.unrestricted ? {} : { departmentId: { in: scope.departmentIds } };
  }

  async assertCanAccessDepartment(actor: TicketAccessActor, departmentId: number): Promise<void> {
    const scope = await this.resolveScope(actor);
    if (!scope.unrestricted && !scope.departmentIds.includes(departmentId)) {
      // Use the same response shape as a missing department to avoid turning a
      // write endpoint into a department-inventory oracle.
      throw new NotFoundException('Department not found');
    }
  }

  async assertCanAccessTicket(actor: TicketAccessActor, ticketId: number): Promise<void> {
    const where = await this.ticketWhere(actor);
    const ticket = await this.prisma.ticket.findFirst({
      where: { AND: [{ id: ticketId }, where] },
      select: { id: true },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');
  }

  /**
   * Validate a whole bulk set before a single mutation starts.  In particular,
   * a mixed Department A/B request cannot update the A rows and report the B
   * rows as "failed" afterwards.
   */
  async assertCanAccessTickets(actor: TicketAccessActor, ticketIds: number[]): Promise<void> {
    const uniqueIds = [...new Set(ticketIds)];
    if (uniqueIds.length === 0) return;

    const where = await this.ticketWhere(actor);
    const visible = await this.prisma.ticket.findMany({
      where: {
        AND: [{ id: { in: uniqueIds } }, where],
      },
      select: { id: true },
    });
    if (visible.length !== uniqueIds.length) throw new NotFoundException('One or more tickets not found');
  }

  /** An attachment is staff-downloadable only through a ticket the actor can see. */
  async assertCanAccessAttachment(actor: TicketAccessActor, attachmentId: number): Promise<void> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
      select: { ticketId: true },
    });
    // Orphan uploads must not become a second staff-file namespace; they become
    // readable only once an authorized ticket action adopts them.
    if (!attachment || attachment.ticketId === null) throw new NotFoundException('Attachment not found');
    await this.assertCanAccessTicket(actor, attachment.ticketId);
  }

  async assertCanAccessTimeEntry(actor: TicketAccessActor, timeEntryId: number): Promise<void> {
    const entry = await this.prisma.timeEntry.findUnique({
      where: { id: timeEntryId },
      select: { ticketId: true },
    });
    if (!entry) throw new NotFoundException('Time entry not found');
    await this.assertCanAccessTicket(actor, entry.ticketId);
  }

  async assertCanAccessFollowUp(actor: TicketAccessActor, followUpId: number): Promise<void> {
    const followUp = await this.prisma.followUp.findUnique({
      where: { id: followUpId },
      select: { ticketId: true },
    });
    if (!followUp) throw new NotFoundException('Follow-up not found');
    await this.assertCanAccessTicket(actor, followUp.ticketId);
  }

  /**
   * Assignees obey the same department rule as readers.  This is intentionally
   * checked at assignment/move time, not only when they later open the ticket,
   * so a department-restricted agent can never become owner of an inaccessible
   * ticket.
   */
  async assertAssigneeCanHandleDepartments(assigneeStaffId: number, departmentIds: number[]): Promise<void> {
    const staff = await this.prisma.staff.findUnique({
      where: { id: assigneeStaffId },
      select: {
        id: true,
        isEnabled: true,
        staffGroup: { select: { isAdmin: true } },
        departments: { select: { departmentId: true } },
      },
    });
    if (!staff) throw new NotFoundException(`Staff ${assigneeStaffId} not found`);
    if (!staff.isEnabled) {
      throw new BadRequestException(`Staff ${assigneeStaffId} is disabled and cannot be assigned`);
    }
    if (staff.staffGroup.isAdmin || staff.departments.length === 0) return;

    const allowed = new Set(staff.departments.map((row) => row.departmentId));
    if (departmentIds.some((departmentId) => !allowed.has(departmentId))) {
      throw new BadRequestException('Assignee cannot access this ticket department');
    }
  }
}
