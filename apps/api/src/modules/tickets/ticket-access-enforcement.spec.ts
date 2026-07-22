import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { PrismaService } from '../../prisma/prisma.service';
import type { UsersService } from '../users/users.service';
import type { SlaService } from '../sla/sla.service';
import type { MailService } from '../mail/mail.service';
import type { AdminService } from '../admin/admin.service';
import { AttachmentsController } from '../attachments/attachments.controller';
import type { AttachmentsService } from '../attachments/attachments.service';
import type { StorageService } from '../attachments/storage.service';
import type { AppConfig } from '../../config/configuration';
import { TimeTrackingService } from '../time-tracking/time-tracking.service';
import { FollowUpsService } from '../follow-ups/follow-ups.service';
import { RecipientsController } from './recipients.controller';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import type { TicketAccessActor } from './ticket-access-policy.service';
import type { TicketAccessPolicy } from './ticket-access-policy.service';

const DEPT_A_AGENT: TicketAccessActor = { staffId: 10, isAdmin: false };

function makeTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 101,
    mask: 'TT-000101',
    subject: 'A only',
    departmentId: 1,
    ownerStaffId: null,
    statusId: 1,
    priorityId: 1,
    typeId: null,
    userId: null,
    requesterName: '',
    requesterEmail: '',
    slaPlanId: null,
    dueAt: null,
    resolutionDueAt: null,
    firstResponseAt: null,
    resolvedAt: null,
    reopenedAt: null,
    isResolved: false,
    totalReplies: 0,
    hasAttachments: false,
    hasNotes: false,
    isEscalated: false,
    escalationLevel: 0,
    wasReopened: false,
    isPhoneCall: false,
    ipAddress: '0.0.0.0',
    messageId: '',
    mergedIntoId: null,
    customFields: {},
    lastActivityAt: new Date(),
    lastReplyAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAccess(overrides: Record<string, unknown> = {}) {
  return {
    ticketWhere: vi.fn().mockResolvedValue({ departmentId: { in: [1] } }),
    assertCanAccessDepartment: vi.fn().mockResolvedValue(undefined),
    assertAssigneeCanHandleDepartments: vi.fn().mockResolvedValue(undefined),
    assertCanAccessTicket: vi.fn().mockResolvedValue(undefined),
    assertCanAccessAttachment: vi.fn().mockResolvedValue(undefined),
    assertCanAccessTimeEntry: vi.fn().mockResolvedValue(undefined),
    assertCanAccessFollowUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeTicketService(prisma: Record<string, unknown>, access: Record<string, unknown>) {
  return new TicketsService(
    prisma as unknown as PrismaService,
    {} as UsersService,
    { computeDueDates: vi.fn(), resolvePlanForTicket: vi.fn() } as unknown as SlaService,
    { emit: vi.fn() } as unknown as EventEmitter2,
    {} as MailService,
    {
      decryptCustomFields: vi.fn().mockImplementation(async (_scope: string, value: unknown) => value),
      decryptCustomFieldsMany: vi.fn().mockResolvedValue(undefined),
    } as unknown as AdminService,
    undefined,
    undefined,
    access as unknown as TicketAccessPolicy,
  );
}

describe('ACL-01 enforcement at staff-facing ticket boundaries', () => {
  it('keeps the list SQL-scoped even when the agent asks for Department B explicitly', async () => {
    const access = makeAccess();
    const prisma = {
      ticket: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
    };
    const service = makeTicketService(prisma, access);

    await service.listTickets(
      {
        page: 1,
        limit: 20,
        sortBy: 'lastActivityAt',
        sortDir: 'desc',
        departmentId: 2,
      } as never,
      DEPT_A_AGENT,
    );

    const where = prisma.ticket.findMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      AND: [{ departmentId: { in: [1] } }, expect.objectContaining({ departmentId: 2, mergedIntoId: null })],
    });
  });

  it('uses a scoped lookup for detail and never falls back to an unscoped findUnique', async () => {
    const access = makeAccess();
    const prisma = {
      ticket: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn() },
    };
    const service = makeTicketService(prisma, access);

    await expect(service.getTicket(202, DEPT_A_AGENT)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ticket.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { AND: [{ id: 202 }, { departmentId: { in: [1] } }] },
      }),
    );
    expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
  });

  it('does not mutate an inaccessible ticket', async () => {
    const access = makeAccess();
    const prisma = {
      ticket: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    };
    const service = makeTicketService(prisma, access);

    await expect(service.changePriority(202, { priorityId: 3 }, 10, DEPT_A_AGENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('does not turn an inbound Message-ID into a cross-department staff read path', async () => {
    const access = makeAccess();
    const prisma = {
      ticket: { findFirst: vi.fn().mockResolvedValue(makeTicket()) },
      ticketPost: {
        findFirst: vi.fn().mockResolvedValue({ id: 88, ticketId: 202, messageId: '<b@example>' }),
      },
    };
    const service = makeTicketService(prisma, access);

    await expect(
      service.reply(
        101,
        {
          contents: 'reply',
          isHtml: false,
          isNote: false,
          isEmailed: false,
          isThirdParty: false,
          incomingMessageId: '<b@example>',
        },
        10,
        DEPT_A_AGENT,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('makes a mixed Department A/B bulk request all-or-nothing', async () => {
    const access = makeAccess();
    const prisma = {
      ticket: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 101, departmentId: 1, isResolved: false, slaPlanId: null }]),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    const service = makeTicketService(prisma, access);

    await expect(
      service.bulkAction({ ids: [101, 202], action: 'unassign' } as never, 10, DEPT_A_AGENT),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('requires Department A access to both sides before merge or link can touch a Department B ticket', async () => {
    const access = makeAccess();
    const prisma = {
      ticket: {
        findFirst: vi.fn().mockResolvedValueOnce(makeTicket()).mockResolvedValueOnce(null),
      },
      $transaction: vi.fn(),
      ticketLink: { create: vi.fn(), findFirst: vi.fn() },
    };
    const service = makeTicketService(prisma, access);

    await expect(service.merge(101, { targetTicketId: 202 }, 10, DEPT_A_AGENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();

    prisma.ticket.findFirst.mockReset().mockResolvedValueOnce(makeTicket()).mockResolvedValueOnce(null);
    await expect(
      service.addLink(101, { targetId: 202, linkType: 'related' }, DEPT_A_AGENT),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ticketLink.create).not.toHaveBeenCalled();
  });

  it('scopes linked-ticket list SQL to the accessible counterpart instead of exposing Department B metadata', async () => {
    const access = makeAccess();
    const prisma = {
      ticket: { findFirst: vi.fn().mockResolvedValue(makeTicket()) },
      ticketLink: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = makeTicketService(prisma, access);

    await expect(service.listLinks(101, DEPT_A_AGENT)).resolves.toEqual([]);
    expect(prisma.ticketLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { sourceId: 101, target: { is: { departmentId: { in: [1] } } } },
            { targetId: 101, source: { is: { departmentId: { in: [1] } } } },
          ],
        },
      }),
    );
  });

  it('requires access to the target department before a move can occur', async () => {
    const access = makeAccess({
      assertCanAccessDepartment: vi.fn().mockRejectedValue(new NotFoundException('Department not found')),
    });
    const prisma = {
      ticket: { findFirst: vi.fn().mockResolvedValue(makeTicket()), update: vi.fn() },
      department: { findUnique: vi.fn() },
    };
    const service = makeTicketService(prisma, access);

    await expect(service.changeDepartment(101, { departmentId: 2 }, 10, DEPT_A_AGENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('does not leak a ticket through an out-of-department watcher notification', async () => {
    const access = makeAccess({
      assertAssigneeCanHandleDepartments: vi.fn().mockRejectedValue(new NotFoundException('Staff not found')),
    });
    const prisma = {
      ticket: { findFirst: vi.fn().mockResolvedValue(makeTicket()) },
      ticketWatcher: { upsert: vi.fn() },
    };
    const service = makeTicketService(prisma, access);

    await expect(service.addWatcher(101, { staffId: 20 }, DEPT_A_AGENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.ticketWatcher.upsert).not.toHaveBeenCalled();
  });

  it('passes the authenticated actor through the controller rather than dropping department context', async () => {
    const listTickets = vi.fn().mockResolvedValue({ data: [], total: 0 });
    const controller = new TicketsController(
      { listTickets } as unknown as TicketsService,
      {} as never,
      {} as never,
    );

    await controller.list(
      { page: 1, limit: 20, sortBy: 'lastActivityAt', sortDir: 'desc' } as never,
      DEPT_A_AGENT as never,
    );
    expect(listTickets).toHaveBeenCalledWith(expect.anything(), DEPT_A_AGENT);
  });
});

describe('ACL-01 relation and attachment endpoints', () => {
  it('does not list B recipients after the policy denies the ticket', async () => {
    const access = makeAccess({ assertCanAccessTicket: vi.fn().mockRejectedValue(new NotFoundException()) });
    const prisma = { ticketRecipient: { findMany: vi.fn() } };
    const controller = new RecipientsController(
      prisma as unknown as PrismaService,
      access as unknown as TicketAccessPolicy,
    );

    await expect(controller.list(202, DEPT_A_AGENT as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ticketRecipient.findMany).not.toHaveBeenCalled();
  });

  it('does not stream a Department B attachment after the policy denies it', async () => {
    const access = makeAccess({
      assertCanAccessAttachment: vi.fn().mockRejectedValue(new NotFoundException()),
    });
    const attachments = { getAttachmentOrThrow: vi.fn() };
    const controller = new AttachmentsController(
      attachments as unknown as AttachmentsService,
      {} as StorageService,
      { TELECOM_HD_UPLOAD_MAX_SIZE_MB: 25 } as AppConfig,
      access as unknown as TicketAccessPolicy,
    );

    await expect(controller.download(7, DEPT_A_AGENT as never, {} as never)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(attachments.getAttachmentOrThrow).not.toHaveBeenCalled();
  });

  it('blocks time and follow-up operations before their service writes or reads Department B data', async () => {
    const access = makeAccess({ assertCanAccessTicket: vi.fn().mockRejectedValue(new NotFoundException()) });
    const timePrisma = { ticket: { findUnique: vi.fn() }, timeEntry: { create: vi.fn() } };
    const followPrisma = { followUp: { findMany: vi.fn() } };
    const time = new TimeTrackingService(
      timePrisma as unknown as PrismaService,
      access as unknown as TicketAccessPolicy,
    );
    const follow = new FollowUpsService(
      followPrisma as unknown as PrismaService,
      access as unknown as TicketAccessPolicy,
    );

    await expect(time.create(202, 10, { minutes: 15 } as never, DEPT_A_AGENT)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(follow.listForTicket(202, DEPT_A_AGENT)).rejects.toBeInstanceOf(NotFoundException);
    expect(timePrisma.timeEntry.create).not.toHaveBeenCalled();
    expect(followPrisma.followUp.findMany).not.toHaveBeenCalled();
  });
});
