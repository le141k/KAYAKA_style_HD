/**
 * Additional coverage for TicketsService: listTickets, getTicket, reply,
 * addNote, changePriority, changeType, split, addWatcher, removeWatcher,
 * addTag, removeTag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { ListTicketsQuerySchema } from './dto';
import type { PrismaService } from '../../prisma/prisma.service';
import type { UsersService } from '../users/users.service';
import type { SlaService } from '../sla/sla.service';
import type { MailService } from '../mail/mail.service';
import type { AdminService } from '../admin/admin.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Ticket } from '@prisma/client';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    kayakoId: null,
    mask: 'TT-000001',
    subject: 'Test ticket',
    departmentId: 1,
    statusId: 1,
    priorityId: 1,
    typeId: null,
    userId: 1,
    requesterName: 'Test User',
    requesterEmail: 'test@example.com',
    ownerStaffId: null,
    slaPlanId: null,
    dueAt: null,
    resolutionDueAt: null,
    firstResponseAt: null,
    resolvedAt: null,
    reopenedAt: null,
    creationMode: 'WEB',
    creator: 'USER',
    flagType: 'NONE',
    totalReplies: 1,
    hasAttachments: false,
    hasNotes: false,
    isResolved: false,
    isEscalated: false,
    escalationLevel: 0,
    wasReopened: false,
    isPhoneCall: false,
    ipAddress: '0.0.0.0',
    messageId: '',
    mergedIntoId: null,
    customFields: {},
    lastReplyAt: null,
    lastActivityAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makePrismaMock() {
  const mock = {
    ticket: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ organizationId: null }),
    },
    staff: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: 1, firstName: 'A', lastName: 'B', email: 'a@b.c', isEnabled: true }),
    },
    ticketPost: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    emailQueue: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    ticketNote: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    attachment: {
      updateMany: vi.fn(),
    },
    ticketStatus: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ id: 3, title: 'In Progress', markAsResolved: false }),
    },
    ticketPriority: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ id: 2, title: 'Normal' }),
    },
    ticketAuditLog: {
      create: vi.fn(),
    },
    workflow: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    workflowEmailEvent: {
      upsert: vi.fn(),
    },
    ticketWatcher: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    ticketTag: {
      findUnique: vi.fn(),
    },
    macro: {
      findUnique: vi.fn(),
    },
    department: {
      findUnique: vi.fn(),
    },
    ticketRecipient: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({}),
    },
    outboundEmail: {
      create: vi.fn().mockResolvedValue({ id: 'outbox-test' }),
    },
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(mock)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  return mock as unknown as PrismaService;
}

function makeUsersMock(): UsersService {
  return {
    findOrCreate: vi.fn().mockResolvedValue({ id: 1, fullName: 'Test User', emails: [] }),
  } as unknown as UsersService;
}

describe('TicketsService (extra coverage)', () => {
  let service: TicketsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let users: UsersService;
  let slaMock: SlaService;
  let eventEmitterMock: EventEmitter2;

  beforeEach(() => {
    prisma = makePrismaMock();
    users = makeUsersMock();
    slaMock = {
      resolvePlanForTicket: vi.fn().mockResolvedValue(null),
      computeDueDates: vi.fn().mockResolvedValue({ dueAt: null, resolutionDueAt: null }),
    } as unknown as SlaService;
    eventEmitterMock = { emit: vi.fn() } as unknown as EventEmitter2;
    const mailMock = {
      sendTemplate: vi.fn().mockResolvedValue(undefined),
    } as unknown as MailService;
    const adminMock = {
      validateCustomFields: vi.fn().mockResolvedValue(undefined),
      encryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
      decryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
      decryptCustomFieldsMany: vi
        .fn()
        .mockImplementation((_s: unknown, rows: unknown) => Promise.resolve(rows)),
    } as unknown as AdminService;
    const notificationMock = {
      queueWatcherNotificationsForUserReply: vi.fn().mockResolvedValue([]),
      queueAssignmentNotification: vi.fn().mockResolvedValue(undefined),
      wakeCommittedNotifications: vi.fn(),
    };
    service = new TicketsService(
      prisma as unknown as PrismaService,
      users,
      slaMock,
      eventEmitterMock,
      mailMock,
      adminMock,
      notificationMock as never,
    );
  });

  // ─── listMyTickets ───────────────────────────────────────────────────────────

  describe('listMyTickets', () => {
    it('returns tickets owned by the verified client userId', async () => {
      const ticket = makeTicket({ userId: 42 });
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await service.listMyTickets(42);
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('scopes the query strictly by userId (no email OR clause)', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listMyTickets(42);

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { mergedIntoId: null, userId: 42 } }),
      );
    });

    it('returns empty list when the client owns no tickets', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      const result = await service.listMyTickets(7);
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  // ─── listTickets ─────────────────────────────────────────────────────────────

  describe('listTickets', () => {
    it('returns paginated ticket data with total', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await service.listTickets({
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortDir: 'desc',
      } as any);

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('applies status filter', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listTickets({
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortDir: 'desc',
        statusId: 2,
      } as any);

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ statusId: 2 }) }),
      );
    });

    it('filters unassigned tickets when unassigned=true', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listTickets({
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortDir: 'desc',
        unassigned: true,
      } as any);

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ ownerStaffId: null }) }),
      );
    });

    it('applies search filter', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listTickets({
        page: 1,
        limit: 10,
        sortBy: 'createdAt',
        sortDir: 'desc',
        search: 'urgent',
      } as any);

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
      );
    });

    it('always excludes merged tickets', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listTickets({ page: 1, limit: 10, sortBy: 'createdAt', sortDir: 'desc' } as any);

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ mergedIntoId: null }) }),
      );
    });
  });

  // ─── getTicket ────────────────────────────────────────────────────────────────

  describe('getTicket', () => {
    it('returns full ticket detail when found', async () => {
      const ticket = {
        ...makeTicket(),
        posts: [],
        notes: [],
        watchers: [],
        tags: [],
        attachments: [],
        auditLogs: [],
      };
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      const result = await service.getTicket(1);
      expect(result.id).toBe(1);
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getTicket(999)).rejects.toThrow(NotFoundException);
    });

    it('selects only non-sensitive user fields (never passwordHash via include)', async () => {
      const ticket = {
        ...makeTicket(),
        posts: [],
        notes: [],
        watchers: [],
        tags: [],
        attachments: [],
        auditLogs: [],
      };
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await service.getTicket(1);

      const arg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        include: { user: { include?: unknown; select?: Record<string, unknown> } };
      };
      const userClause = arg.include.user;
      // Must use a narrow `select`, never `include` (which pulls passwordHash).
      expect(userClause.include).toBeUndefined();
      expect(userClause.select).toBeDefined();
      expect(userClause.select!['passwordHash']).toBeUndefined();
      expect(userClause.select!['fullName']).toBe(true);
    });

    it('projects delivery truth for staff without recipients or BCC', async () => {
      const ticket = {
        ...makeTicket(),
        posts: [],
        notes: [],
        watchers: [],
        tags: [],
        attachments: [],
        auditLogs: [],
      };
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await service.getTicket(1);

      const arg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        include: { posts: { include: { outboundEmail: { select: Record<string, unknown> } } } };
      };
      const delivery = arg.include.posts.include.outboundEmail.select;
      expect(delivery['state']).toBe(true);
      expect(delivery['lastError']).toBe(true);
      expect(delivery['recipients']).toBeUndefined();
      expect(delivery['bcc']).toBeUndefined();
      expect(delivery['htmlBody']).toBeUndefined();
    });
  });

  // ─── getTicketByMask ──────────────────────────────────────────────────────────

  describe('getTicketByMask', () => {
    it('returns ticket by mask', async () => {
      const ticket = {
        ...makeTicket(),
        posts: [],
        notes: [],
        watchers: [],
        tags: [],
        attachments: [],
        auditLogs: [],
      };
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      const result = await service.getTicketByMask('TT-000001');
      expect(result.mask).toBe('TT-000001');
    });

    it('throws NotFoundException when mask not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getTicketByMask('TT-999999')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── reply ───────────────────────────────────────────────────────────────────

  describe('reply', () => {
    it('creates a staff post reply and updates ticket metadata without claiming SMTP delivery', async () => {
      const ticket = makeTicket({ firstResponseAt: null });
      const post = { id: 10, ticketId: 1, contents: 'Reply here' };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(post);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.reply(
        1,
        {
          contents: 'Reply here',
          isHtml: false,
          isEmailed: false,
          isThirdParty: false,
          creationMode: 'STAFF',
          ipAddress: '127.0.0.1',
          isNote: false,
        } as any,
        5,
      );

      expect(result).toBe(post);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ totalReplies: { increment: 1 } }),
        }),
      );
    });

    it('creates a note when isNote=true', async () => {
      const ticket = makeTicket();
      const note = { id: 20, ticketId: 1, contents: 'Internal note' };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(ticket) // first call in reply()
        .mockResolvedValue(ticket); // subsequent calls
      (prisma.ticketNote.create as ReturnType<typeof vi.fn>).mockResolvedValue(note);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.reply(
        1,
        {
          contents: 'Internal note',
          isHtml: false,
          isEmailed: false,
          isThirdParty: false,
          creationMode: 'STAFF',
          ipAddress: '127.0.0.1',
          isNote: true,
        } as any,
        5,
      );

      expect(prisma.ticketNote.create).toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.reply(999, { contents: 'Test', isNote: false } as any, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('reopens a resolved ticket when a USER (non-staff) replies', async () => {
      const ticket = makeTicket({ isResolved: true });
      const post = { id: 11, ticketId: 1, contents: 'Customer follow-up' };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(post);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });

      // No staffId → USER reply
      await service.reply(
        1,
        {
          contents: 'Customer follow-up',
          isHtml: false,
          isEmailed: false,
          isThirdParty: false,
          creationMode: 'WEB',
          ipAddress: '0.0.0.0',
          isNote: false,
        } as any,
        undefined,
      );

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            statusId: 7,
            isResolved: false,
            resolvedAt: null,
            wasReopened: true,
          }),
        }),
      );
    });

    it('does NOT reopen a resolved ticket when STAFF replies', async () => {
      const ticket = makeTicket({ isResolved: true });
      const post = { id: 12, ticketId: 1, contents: 'Staff note reply' };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(post);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });

      await service.reply(
        1,
        {
          contents: 'Staff note reply',
          isHtml: false,
          isEmailed: false,
          isThirdParty: false,
          creationMode: 'STAFF',
          ipAddress: '0.0.0.0',
          isNote: false,
        } as any,
        5,
      );

      const updateCall = (prisma.ticket.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(updateCall.data).not.toHaveProperty('isResolved');
      expect(updateCall.data).not.toHaveProperty('statusId');
    });

    it('does not set firstResponseAt if already set', async () => {
      const ticket = makeTicket({ firstResponseAt: new Date('2025-01-01') });
      const post = { id: 10, ticketId: 1, contents: 'Another reply' };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(post);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.reply(
        1,
        {
          contents: 'Another reply',
          isHtml: false,
          isNote: false,
          isEmailed: false,
          isThirdParty: false,
          creationMode: 'STAFF',
          ipAddress: '127.0.0.1',
        } as any,
        5,
      );

      // firstResponseAt should NOT be included in update since it was already set
      const updateCall = (prisma.ticket.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(updateCall.data).not.toHaveProperty('firstResponseAt');
    });
  });

  // ─── changePriority ──────────────────────────────────────────────────────────

  describe('changePriority', () => {
    it('updates priorityId and writes audit log', async () => {
      const ticket = makeTicket({ priorityId: 1 });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...ticket, priorityId: 3 });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.changePriority(1, { priorityId: 3 }, 5);
      expect(result.priorityId).toBe(3);
      expect(prisma.ticketAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'PRIORITY_CHANGE' }),
        }),
      );
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.changePriority(999, { priorityId: 1 }, 5)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── changeType ──────────────────────────────────────────────────────────────

  describe('changeType', () => {
    it('updates typeId and writes audit log', async () => {
      const ticket = makeTicket({ typeId: null });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...ticket, typeId: 2 });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.changeType(1, { typeId: 2 }, 5);
      expect(result.typeId).toBe(2);
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.changeType(999, { typeId: 1 }, 5)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── changeStatus (extra paths) ──────────────────────────────────────────────

  describe('changeStatus (extra paths)', () => {
    it('throws NotFoundException when status not found', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.changeStatus(1, { statusId: 99 }, 5)).rejects.toThrow(NotFoundException);
    });

    it('recomputes SLA when re-opening a resolved ticket with SLA plan', async () => {
      const ticket = makeTicket({ isResolved: true, slaPlanId: 1 });
      const status = { id: 2, markAsResolved: false };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(status);
      (slaMock.computeDueDates as ReturnType<typeof vi.fn>).mockResolvedValue({
        dueAt: new Date(),
        resolutionDueAt: new Date(),
      });
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({ ...ticket, isResolved: false });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.changeStatus(1, { statusId: 2 }, 5);

      expect(slaMock.computeDueDates).toHaveBeenCalled();
    });
  });

  // ─── addWatcher / removeWatcher ───────────────────────────────────────────────

  describe('addWatcher', () => {
    it('upserts a ticket watcher', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      (prisma.ticketWatcher.upsert as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.addWatcher(1, { staffId: 5 } as any);
      expect(prisma.ticketWatcher.upsert).toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.addWatcher(999, { staffId: 5 } as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeWatcher', () => {
    it('deletes watcher record', async () => {
      (prisma.ticketWatcher.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      await service.removeWatcher(1, 5);
      expect(prisma.ticketWatcher.deleteMany).toHaveBeenCalledWith({ where: { ticketId: 1, staffId: 5 } });
    });
  });

  // ─── addTag / removeTag ──────────────────────────────────────────────────────

  describe('addTag', () => {
    it('connects or creates a tag on the ticket', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.addTag(1, { name: 'vip' } as any);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tags: expect.objectContaining({ connectOrCreate: expect.any(Object) }),
          }),
        }),
      );
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.addTag(999, { name: 'vip' } as any)).rejects.toThrow(NotFoundException);
    });
  });

  describe('removeTag', () => {
    it('disconnects the tag when found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      (prisma.ticketTag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ name: 'vip' });
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.removeTag(1, 'vip');
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tags: { disconnect: { name: 'vip' } } }),
        }),
      );
    });

    it('is idempotent when tag does not exist', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      (prisma.ticketTag.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await service.removeTag(1, 'nonexistent');
      expect(prisma.ticket.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.removeTag(999, 'vip')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── applyMacro ──────────────────────────────────────────────────────────────

  describe('applyMacro', () => {
    it('posts reply text when macro has replyText', async () => {
      const ticket = makeTicket({ firstResponseAt: null });
      const macro = {
        id: 1,
        title: 'Test Macro',
        replyText: 'Hello from macro',
        actions: [],
        categoryId: null,
        createdAt: new Date(),
      };
      const updatedTicket = makeTicket();

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(macro);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 10 });
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTicket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTicket);

      const result = await service.applyMacro(1, { macroId: 1 }, 5);

      expect(prisma.ticketPost.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ contents: 'Hello from macro', staffId: 5 }),
        }),
      );
      expect(result).toBe(updatedTicket);
    });

    it('executes set_status and set_priority actions', async () => {
      const ticket = makeTicket({ firstResponseAt: new Date() });
      const macro = {
        id: 2,
        title: 'Status Macro',
        replyText: '',
        actions: [
          { type: 'set_status', statusId: 3 },
          { type: 'set_priority', priorityId: 2 },
        ],
        categoryId: null,
        createdAt: new Date(),
      };
      const updatedTicket = makeTicket({ statusId: 3, priorityId: 2 });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(macro);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTicket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTicket);

      await service.applyMacro(1, { macroId: 2 }, 5);

      // statusId is applied via changeStatus() (its own update), priorityId via the
      // macro's raw update — assert both happened across the update calls.
      const updateCalls = (prisma.ticket.update as ReturnType<typeof vi.fn>).mock.calls;
      const dataObjs = updateCalls.map((c: unknown[]) => (c[0] as { data: Record<string, unknown> }).data);
      expect(dataObjs.some((d) => d.statusId === 3)).toBe(true);
      expect(dataObjs.some((d) => d.priorityId === 2)).toBe(true);
    });

    it('executes add_tag action', async () => {
      const ticket = makeTicket();
      const macro = {
        id: 3,
        title: 'Tag Macro',
        replyText: '',
        actions: [{ type: 'add_tag', tag: 'urgent' }],
        categoryId: null,
        createdAt: new Date(),
      };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(macro);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await service.applyMacro(1, { macroId: 3 }, 5);

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tags: expect.objectContaining({ connectOrCreate: expect.any(Object) }),
          }),
        }),
      );
    });

    it('ADM-1: add_tag fires from the UI {type,value} shape (value → tag name)', async () => {
      const ticket = makeTicket();
      const macro = {
        id: 31,
        title: 'UI Tag Macro',
        replyText: '',
        // The admin builder serializes actions as {type, value} (no typed `tag` key).
        actions: [{ type: 'add_tag', value: 'vip' }],
        categoryId: null,
        createdAt: new Date(),
      };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(macro);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await service.applyMacro(1, { macroId: 31 }, 5);

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tags: expect.objectContaining({
              connectOrCreate: expect.objectContaining({
                where: { name: 'vip' },
                create: { name: 'vip' },
              }),
            }),
          }),
        }),
      );
    });

    it('ADM-1: add_note fires from the UI {type,value} shape (value → note text)', async () => {
      const ticket = makeTicket();
      const macro = {
        id: 32,
        title: 'UI Note Macro',
        replyText: '',
        actions: [{ type: 'add_note', value: 'check billing' }],
        categoryId: null,
        createdAt: new Date(),
      };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(macro);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketNote.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await service.applyMacro(1, { macroId: 32 }, 5);

      expect(prisma.ticketNote.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contents: expect.stringContaining('check billing'),
          }),
        }),
      );
    });

    it('writes audit log entry with MACRO_APPLIED action', async () => {
      const ticket = makeTicket();
      const macro = {
        id: 4,
        title: 'Audit Macro',
        replyText: '',
        actions: [],
        categoryId: null,
        createdAt: new Date(),
      };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(macro);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await service.applyMacro(1, { macroId: 4 }, 5);

      expect(prisma.ticketAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'MACRO_APPLIED' }),
        }),
      );
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.applyMacro(999, { macroId: 1 }, 5)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when macro not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      (prisma.macro.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.applyMacro(1, { macroId: 999 }, 5)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── changeDepartment ─────────────────────────────────────────────────────────

  describe('changeDepartment', () => {
    it('updates departmentId and writes audit log', async () => {
      const ticket = makeTicket({ departmentId: 1 });
      const dept = { id: 2, title: 'Support' };
      const updatedTicket = makeTicket({ departmentId: 2 });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(dept);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedTicket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.changeDepartment(1, { departmentId: 2 }, 5);

      expect(result.departmentId).toBe(2);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ departmentId: 2 }) }),
      );
      expect(prisma.ticketAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: 'DEPARTMENT_CHANGE', field: 'departmentId' }),
        }),
      );
    });

    it('throws NotFoundException when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.changeDepartment(999, { departmentId: 1 }, 5)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when department not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      (prisma.department.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.changeDepartment(1, { departmentId: 999 }, 5)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── split ───────────────────────────────────────────────────────────────────

  describe('split', () => {
    it('throws BadRequestException when postIds is empty', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      await expect(
        service.split(1, { subject: 'New ticket', postIds: [], departmentId: 1 } as any, 5),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when some postIds do not belong to ticket', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      // Return only 1 post when 2 were requested
      (prisma.ticketPost.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 1 }]);
      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      (prisma.ticketPriority.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });

      await expect(service.split(1, { subject: 'New ticket', postIds: [1, 2] } as any, 5)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('creates new ticket and moves posts on success', async () => {
      const source = makeTicket({ id: 1, totalReplies: 3 });
      const newTicket = { ...makeTicket(), id: 99, mask: 'TT-PENDING' };
      const updatedNewTicket = { ...newTicket, mask: 'TT-000099' };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(source);
      (prisma.ticketPost.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 5 }, { id: 6 }]);
      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      (prisma.ticketPriority.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      (prisma.ticket.create as ReturnType<typeof vi.fn>).mockResolvedValue(newTicket);
      // Split now runs an interactive $transaction(async tx => …); the default mock
      // passthrough executes the callback. The post-move must report it moved both.
      (prisma.ticketPost.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(updatedNewTicket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(updatedNewTicket);

      const result = await service.split(1, { subject: 'New ticket', postIds: [5, 6] } as any, 5);
      expect(result.mask).toBe('TT-000099');
      expect(prisma.ticket.create).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
      // The post-move is scoped to the source ticket (TOCTOU/IDOR guard).
      expect(prisma.ticketPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ ticketId: 1 }) }),
      );
    });
  });

  describe('bulkAction', () => {
    const fm = () => prisma.ticket.findMany as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      // bulkAction now uses the returned update row as the immutable snapshot
      // for its in-transaction notification/workflow planners, and its audit id
      // as the durable source key. Real Prisma always returns both values.
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
    });

    it('applies a status change atomically to every existing id', async () => {
      fm().mockResolvedValue([
        { id: 1, isResolved: false },
        { id: 2, isResolved: false },
      ]);
      (prisma.ticketStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        markAsResolved: false,
      });

      const res = await service.bulkAction({ ids: [1, 2], action: 'status', statusId: 4 }, 7);

      expect(res).toEqual({ updated: 2, failed: [] });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 }, data: expect.objectContaining({ statusId: 4 }) }),
      );
      expect(prisma.ticketAuditLog.create).toHaveBeenCalledTimes(2);
    });

    it('sets isResolved when the target status marks resolved', async () => {
      fm().mockResolvedValue([{ id: 1, isResolved: false }]);
      (prisma.ticketStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        markAsResolved: true,
      });

      await service.bulkAction({ ids: [1], action: 'status', statusId: 9 }, 7);

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ isResolved: true, dueAt: null }) }),
      );
    });

    it('recomputes SLA when a bulk status change reopens a resolved ticket', async () => {
      fm().mockResolvedValue([{ id: 1, isResolved: true, slaPlanId: 3 }]);
      (prisma.ticketStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        markAsResolved: false,
      });
      const due = {
        dueAt: new Date('2026-07-01T00:00:00Z'),
        resolutionDueAt: new Date('2026-07-02T00:00:00Z'),
      };
      (slaMock.computeDueDates as ReturnType<typeof vi.fn>).mockResolvedValue(due);

      await service.bulkAction({ ids: [1], action: 'status', statusId: 2 }, 7);

      expect(slaMock.computeDueDates).toHaveBeenCalledWith(3, expect.any(Date));
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            isResolved: false,
            wasReopened: true,
            dueAt: due.dueAt,
            resolutionDueAt: due.resolutionDueAt,
          }),
        }),
      );
    });

    it('assigns an owner to every id', async () => {
      fm().mockResolvedValue([{ id: 10, isResolved: false }]);
      const res = await service.bulkAction({ ids: [10], action: 'assignee', ownerStaffId: 5 }, 7);
      expect(res.updated).toBe(1);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerStaffId: 5 }) }),
      );
    });

    it('unassigns (ownerStaffId → null) on the unassign action', async () => {
      fm().mockResolvedValue([{ id: 10, isResolved: false }]);
      const res = await service.bulkAction({ ids: [10], action: 'unassign' }, 7);
      expect(res.updated).toBe(1);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ownerStaffId: null }) }),
      );
    });

    it('reports non-existent ids in failed[] and never touches them', async () => {
      // Only id 1 exists; 2 and 99 do not.
      fm().mockResolvedValue([{ id: 1, isResolved: false }]);
      (prisma.ticketStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        markAsResolved: false,
      });

      const res = await service.bulkAction({ ids: [1, 2, 99], action: 'status', statusId: 4 }, 7);

      expect(res.updated).toBe(1);
      expect(res.failed).toEqual([2, 99]);
      expect(prisma.ticket.update).toHaveBeenCalledTimes(1);
    });

    it('returns all-failed without a transaction when no id exists', async () => {
      fm().mockResolvedValue([]);
      const res = await service.bulkAction({ ids: [7, 8], action: 'unassign' }, 7);
      expect(res).toEqual({ updated: 0, failed: [7, 8] });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('listTickets — sla_breached + tags', () => {
    it('filters SLA-breached tickets server-side (unresolved + dueAt in past)', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listTickets({
        page: 1,
        limit: 20,
        sortBy: 'lastActivityAt',
        sortDir: 'desc',
        sla_breached: true,
      } as any);

      const arg = (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        where: { isResolved?: boolean; dueAt?: { lt: Date } };
        include: Record<string, unknown>;
      };
      expect(arg.where.isResolved).toBe(false);
      expect(arg.where.dueAt).toHaveProperty('lt');
      // tags are included so the list can render them (were undefined before).
      expect(arg.include.tags).toEqual({ select: { name: true } });
    });

    it('sla_breached=false does NOT apply the breach filter', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      // The schema parses 'false' → false (not the z.coerce.boolean footgun);
      // listTickets must then leave the breach where-clause off.
      const parsed = ListTicketsQuerySchema.parse({ sla_breached: 'false' });
      expect(parsed.sla_breached).toBe(false);

      await service.listTickets(parsed);

      const arg = (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        where: Record<string, unknown>;
      };
      // No SLA narrowing: dueAt absent, and isResolved not forced to false by the breach path.
      expect(arg.where.dueAt).toBeUndefined();
    });
  });
});
