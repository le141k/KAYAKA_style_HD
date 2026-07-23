import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthStaff } from '../../auth/auth.decorators';
import { PrismaService } from '../../prisma/prisma.service';

/** The authenticated principal required for a department-scoped mail action. */
export type MailAccessActor = Pick<AuthStaff, 'staffId' | 'isAdmin'> & { email?: string };

export interface MailDepartmentScope {
  /** Only an actual global administrator may access global or unassigned mail data. */
  unrestricted: boolean;
  departmentIds: number[];
}

/**
 * Central, fail-closed department policy for mail operator operations.
 *
 * A missing department assignment is deliberately not treated like broad ticket
 * access: queues contain credentials and delivery records contain customer mail
 * metadata, so a non-admin with no explicit department receives an empty scope.
 */
@Injectable()
export class MailAccessPolicy {
  constructor(private readonly prisma: PrismaService) {}

  async resolveScope(actor: MailAccessActor): Promise<MailDepartmentScope> {
    this.assertValidActor(actor);
    if (actor.isAdmin) return { unrestricted: true, departmentIds: [] };

    const assignments = await this.prisma.departmentStaff.findMany({
      where: { staffId: actor.staffId },
      select: { departmentId: true },
    });
    return {
      unrestricted: false,
      departmentIds: [...new Set(assignments.map((assignment) => assignment.departmentId))],
    };
  }

  queueWhereForScope(scope: MailDepartmentScope): Prisma.EmailQueueWhereInput {
    return scope.unrestricted ? {} : { departmentId: { in: scope.departmentIds } };
  }

  queueByIdWhereForScope(id: number, scope: MailDepartmentScope): Prisma.EmailQueueWhereInput {
    return scope.unrestricted ? { id } : { AND: [{ id }, this.queueWhereForScope(scope)] };
  }

  ticketWhereForScope(scope: MailDepartmentScope): Prisma.TicketWhereInput {
    return scope.unrestricted ? {} : { departmentId: { in: scope.departmentIds } };
  }

  /**
   * A delivery is governed only by its durable effective owner: inbound routing may
   * accept through queue A yet create/update a ticket in B/C. Ticket-owned rows join
   * the target ticket so a department move is reflected immediately. UNRESOLVED and a
   * deleted target ticket match no non-admin scope (fail closed).
   */
  deliveryWhereForScope(scope: MailDepartmentScope): Prisma.InboundDeliveryWhereInput {
    if (scope.unrestricted) return {};
    const allowed = { in: scope.departmentIds };
    return {
      OR: [
        {
          effectiveOwnerKind: { in: ['RECEIVING', 'ROUTED'] },
          effectiveOwnerDepartmentId: allowed,
        },
        {
          effectiveOwnerKind: 'TICKET',
          effectiveOwnerTicket: { is: { departmentId: allowed } },
        },
      ],
    };
  }

  deliveryByIdWhereForScope(id: number, scope: MailDepartmentScope): Prisma.InboundDeliveryWhereInput {
    return scope.unrestricted ? { id } : { AND: [{ id }, this.deliveryWhereForScope(scope)] };
  }

  /** Non-admins may neither create nor move a queue outside their assignments. */
  assertCanTargetQueueDepartment(scope: MailDepartmentScope, departmentId: number | null | undefined): void {
    if (scope.unrestricted) return;
    if (departmentId === null || departmentId === undefined || !scope.departmentIds.includes(departmentId)) {
      // Same shape as a missing resource: do not expose department inventory.
      throw new NotFoundException('Department not found');
    }
  }

  private assertValidActor(actor: MailAccessActor): void {
    if (
      !actor ||
      !Number.isInteger(actor.staffId) ||
      actor.staffId <= 0 ||
      typeof actor.isAdmin !== 'boolean'
    ) {
      throw new ForbiddenException('Invalid mail operator context');
    }
  }
}
