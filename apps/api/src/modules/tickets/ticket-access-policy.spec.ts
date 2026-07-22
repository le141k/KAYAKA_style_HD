import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service';
import { TicketAccessPolicy } from './ticket-access-policy.service';

const DEPT_A_AGENT = { staffId: 10, isAdmin: false } as const;
const ADMIN = { staffId: 99, isAdmin: true } as const;

function makePrisma() {
  return {
    departmentStaff: { findMany: vi.fn().mockResolvedValue([{ departmentId: 1 }]) },
    ticket: {
      findFirst: vi.fn().mockResolvedValue({ id: 101 }),
      findMany: vi.fn().mockResolvedValue([{ id: 101 }]),
    },
    attachment: { findUnique: vi.fn().mockResolvedValue({ ticketId: 101 }) },
    timeEntry: { findUnique: vi.fn().mockResolvedValue({ ticketId: 101 }) },
    followUp: { findUnique: vi.fn().mockResolvedValue({ ticketId: 101 }) },
    staff: {
      findUnique: vi.fn().mockResolvedValue({
        id: 20,
        isEnabled: true,
        staffGroup: { isAdmin: false },
        departments: [{ departmentId: 1 }],
      }),
    },
  };
}

describe('TicketAccessPolicy — ACL-01 department isolation', () => {
  it('keeps administrators unrestricted without querying DepartmentStaff', async () => {
    const prisma = makePrisma();
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.ticketWhere(ADMIN)).resolves.toEqual({});
    expect(prisma.departmentStaff.findMany).not.toHaveBeenCalled();
  });

  it('fails closed for a non-admin with no DepartmentStaff rows', async () => {
    const prisma = makePrisma();
    prisma.departmentStaff.findMany.mockResolvedValue([]);
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.ticketWhere(DEPT_A_AGENT)).resolves.toEqual({
      department: { is: { staff: { some: { staffId: DEPT_A_AGENT.staffId } } } },
    });
    await expect(policy.assertCanAccessDepartment(DEPT_A_AGENT, 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('builds a SQL department predicate for a restricted staff member', async () => {
    const prisma = makePrisma();
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.ticketWhere(DEPT_A_AGENT)).resolves.toEqual({
      department: { is: { staff: { some: { staffId: DEPT_A_AGENT.staffId } } } },
    });
  });

  it('does not disclose a Department B ticket to a Department A agent', async () => {
    const prisma = makePrisma();
    prisma.ticket.findFirst.mockResolvedValue(null);
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.assertCanAccessTicket(DEPT_A_AGENT, 202)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: {
        AND: [{ id: 202 }, { department: { is: { staff: { some: { staffId: DEPT_A_AGENT.staffId } } } } }],
      },
      select: { id: true },
    });
  });

  it('rejects a mixed A/B bulk set before any caller can mutate the visible subset', async () => {
    const prisma = makePrisma();
    prisma.ticket.findMany.mockResolvedValue([{ id: 101 }]);
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.assertCanAccessTickets(DEPT_A_AGENT, [101, 202])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('requires attachment, time entry, and follow-up access through their owning ticket', async () => {
    const prisma = makePrisma();
    prisma.ticket.findFirst.mockResolvedValue(null);
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.assertCanAccessAttachment(DEPT_A_AGENT, 7)).rejects.toBeInstanceOf(NotFoundException);
    await expect(policy.assertCanAccessTimeEntry(DEPT_A_AGENT, 8)).rejects.toBeInstanceOf(NotFoundException);
    await expect(policy.assertCanAccessFollowUp(DEPT_A_AGENT, 9)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects assignment of a Department B ticket to a Department A-only assignee', async () => {
    const prisma = makePrisma();
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.assertAssigneeCanHandleDepartments(20, [2])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('re-checks target membership inside a write transaction', async () => {
    const prisma = makePrisma();
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);
    const transaction = {
      departmentStaff: { findUnique: vi.fn().mockResolvedValue(null) },
    };

    await expect(
      policy.assertCanAccessDepartmentInTransaction(DEPT_A_AGENT, 1, transaction as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction.departmentStaff.findUnique).toHaveBeenCalledWith({
      where: { departmentId_staffId: { departmentId: 1, staffId: DEPT_A_AGENT.staffId } },
      select: { departmentId: true },
    });
  });

  it('fences a child-row mutation with an atomic SQL-scoped ticket update', async () => {
    const prisma = makePrisma();
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);
    const transaction = { ticket: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } };

    await expect(
      policy.fenceTicketMutation(transaction as never, DEPT_A_AGENT, 202, new Date('2026-07-22T00:00:00Z')),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(transaction.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ id: 202 }, { department: { is: { staff: { some: { staffId: DEPT_A_AGENT.staffId } } } } }],
        },
      }),
    );
  });

  it('rejects an unassigned non-admin assignee for every department', async () => {
    const prisma = makePrisma();
    prisma.staff.findUnique.mockResolvedValue({
      id: 20,
      isEnabled: true,
      staffGroup: { isAdmin: false },
      departments: [],
    });
    const policy = new TicketAccessPolicy(prisma as unknown as PrismaService);

    await expect(policy.assertAssigneeCanHandleDepartments(20, [1, 2])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
