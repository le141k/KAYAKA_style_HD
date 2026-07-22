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
  /** Only global administrators are unrestricted. */
  unrestricted: boolean;
  departmentIds: number[];
}

/**
 * One authoritative policy for every staff-facing ticket boundary.
 *
 * A DepartmentStaff row is an explicit allow-list. A non-administrator without
 * a row is deliberately denied every department; the only unrestricted role is
 * a global administrator. Ticket lookups use a scoped SQL predicate instead of
 * reading a row first and filtering it in application code, so unauthorized
 * callers do not receive ticket/post/note data while the page is being assembled.
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
    return { unrestricted: false, departmentIds };
  }

  async ticketWhere(actor: TicketAccessActor): Promise<Prisma.TicketWhereInput> {
    if (actor.isAdmin) return {};
    // Keep ordinary reads and conditional writes tied to DepartmentStaff in the
    // same SQL statement. Resolving IDs first is fine for dashboards, but it
    // leaves a window in which a just-revoked assignment can still be used by a
    // following mutation. This relation predicate closes that window and is
    // naturally deny-all when the staff member has no assignment rows.
    return {
      department: {
        is: {
          staff: {
            some: { staffId: actor.staffId },
          },
        },
      },
    };
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

  /**
   * Re-check a target department from inside the caller's write transaction.
   * This is used for staff-created/moved tickets, where a stale preflight check
   * must not survive a concurrent DepartmentStaff revocation.
   */
  async assertCanAccessDepartmentInTransaction(
    actor: TicketAccessActor,
    departmentId: number,
    transaction: Prisma.TransactionClient,
  ): Promise<void> {
    if (actor.isAdmin) return;
    const membership = await transaction.departmentStaff.findUnique({
      where: { departmentId_staffId: { departmentId, staffId: actor.staffId } },
      select: { departmentId: true },
    });
    if (!membership) throw new NotFoundException('Department not found');
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
   * Atomically prove the actor can still mutate this ticket and retain a row
   * lock until the enclosing transaction commits. The conditional write is the
   * mutation fence for child rows (posts, notes, links, time and follow-ups),
   * which otherwise cannot carry a ticket department predicate themselves.
   */
  async fenceTicketMutation(
    transaction: Prisma.TransactionClient,
    actor: TicketAccessActor,
    ticketId: number,
    now: Date,
  ): Promise<void> {
    const result = await transaction.ticket.updateMany({
      where: {
        AND: [{ id: ticketId }, await this.ticketWhere(actor)],
      },
      data: { lastActivityAt: now },
    });
    if (result.count !== 1) throw new NotFoundException('Ticket not found');
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
    if (staff.staffGroup.isAdmin) return;

    const allowed = new Set(staff.departments.map((row) => row.departmentId));
    if (departmentIds.some((departmentId) => !allowed.has(departmentId))) {
      throw new BadRequestException('Assignee cannot access this ticket department');
    }
  }
}
