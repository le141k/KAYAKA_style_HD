/**
 * H8-1 / H8-5 — applyMacro action routing. Owner/status/priority/department
 * changes must go through the validated change-helpers / assign() (so notification,
 * audit + SLA fire and dangling FKs are rejected), not a raw FK-blind update.
 */
import { ForbiddenException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TicketsService } from './tickets.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { UsersService } from '../users/users.service';
import type { SlaService } from '../sla/sla.service';
import type { MailService } from '../mail/mail.service';
import type { AdminService } from '../admin/admin.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';

function makePrisma(macroActions: unknown[]) {
  return {
    ticket: {
      findUnique: vi.fn().mockResolvedValue({ id: 1, mask: 'TT-000001' }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 1, mask: 'TT-000001' }),
      findFirst: vi.fn().mockResolvedValue({ id: 1, mask: 'TT-000001', firstResponseAt: null }),
      update: vi.fn(),
    },
    macro: {
      findUnique: vi.fn().mockResolvedValue({ id: 9, title: 'M', replyText: '', actions: macroActions }),
    },
    staff: { findUnique: vi.fn() },
    ticketPriority: { findUnique: vi.fn() },
    department: { findUnique: vi.fn() },
    ticketStatus: { findUnique: vi.fn() },
    ticketAuditLog: { create: vi.fn().mockResolvedValue({}) },
  } as unknown as PrismaService;
}

function makeService(prisma: PrismaService, access?: Record<string, unknown>): TicketsService {
  return new TicketsService(
    prisma,
    {} as unknown as UsersService,
    {} as unknown as SlaService,
    { emit: vi.fn() } as unknown as EventEmitter2,
    {} as unknown as MailService,
    {} as unknown as AdminService,
    {} as never,
    undefined,
    access as never,
  );
}

describe('applyMacro — action routing (H8-1/H8-5)', () => {
  let prisma: PrismaService;
  let service: TicketsService;

  function arm(actions: unknown[]) {
    prisma = makePrisma(actions);
    service = makeService(prisma);
  }

  beforeEach(() => vi.restoreAllMocks());

  it('routes a UI {type:assign,value} through assign() when the staff exists', async () => {
    arm([{ type: 'assign', value: '7' }]);
    (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });
    const assignSpy = vi.spyOn(service, 'assign').mockResolvedValue({} as never);

    await service.applyMacro(1, { macroId: 9 }, 5);

    expect(assignSpy).toHaveBeenCalledWith(1, { ownerStaffId: 7 }, 5);
  });

  it('skips assign (no assign()) when the staff id does not exist', async () => {
    arm([{ type: 'assign', value: '999' }]);
    (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const assignSpy = vi.spyOn(service, 'assign').mockResolvedValue({} as never);

    await service.applyMacro(1, { macroId: 9 }, 5);

    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('routes set_priority through changePriority() when the priority exists', async () => {
    arm([{ type: 'set_priority', value: '2' }]);
    (prisma.ticketPriority.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 2 });
    const spy = vi.spyOn(service, 'changePriority').mockResolvedValue({} as never);

    await service.applyMacro(1, { macroId: 9 }, 5);

    expect(spy).toHaveBeenCalledWith(1, { priorityId: 2 }, 5);
  });

  it('skips set_priority for a dangling priority id', async () => {
    arm([{ type: 'set_priority', value: '404' }]);
    (prisma.ticketPriority.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const spy = vi.spyOn(service, 'changePriority').mockResolvedValue({} as never);

    await service.applyMacro(1, { macroId: 9 }, 5);

    expect(spy).not.toHaveBeenCalled();
  });

  it('routes change_department through changeDepartment() when it exists', async () => {
    arm([{ type: 'change_department', value: '3' }]);
    (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 3 });
    const spy = vi.spyOn(service, 'changeDepartment').mockResolvedValue({} as never);

    await service.applyMacro(1, { macroId: 9 }, 5);

    expect(spy).toHaveBeenCalledWith(1, { departmentId: 3 }, 5);
  });

  it('does not let ticket.edit impersonate ticket.reply through a macro', async () => {
    arm([]);
    (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 9,
      title: 'Reply macro',
      replyText: 'A customer-facing reply',
      actions: [],
    });
    service = makeService(prisma, {
      ticketWhere: vi.fn().mockResolvedValue({}),
      fenceTicketMutation: vi.fn().mockResolvedValue(undefined),
    });

    await expect(
      service.applyMacro(1, { macroId: 9 }, 5, {
        staffId: 5,
        email: 'agent@example.test',
        isAdmin: false,
        permissions: ['ticket.edit'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });
});
