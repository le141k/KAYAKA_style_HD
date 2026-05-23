/**
 * Additional coverage for TicketsService: listTickets, getTicket, reply,
 * addNote, changePriority, changeType, split, addWatcher, removeWatcher,
 * addTag, removeTag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
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
  return {
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
      findUnique: vi.fn().mockResolvedValue({ id: 1, firstName: 'A', lastName: 'B', email: 'a@b.c' }),
    },
    ticketPost: {
      create: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
    },
    ticketNote: {
      create: vi.fn(),
    },
    ticketStatus: {
      findFirst: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({ id: 3, title: 'In Progress', markAsResolved: false }),
    },
    ticketPriority: {
      findFirst: vi.fn(),
    },
    ticketAuditLog: {
      create: vi.fn(),
    },
    ticketWatcher: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
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
    $transaction: vi.fn(),
  } as unknown as PrismaService;
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
    } as unknown as AdminService;
    service = new TicketsService(
      prisma as unknown as PrismaService,
      users,
      slaMock,
      eventEmitterMock,
      mailMock,
      adminMock,
    );
  });

  // ─── listMyTickets ───────────────────────────────────────────────────────────

  describe('listMyTickets', () => {
    it('returns tickets matching requesterEmail', async () => {
      const ticket = makeTicket({ requesterEmail: 'jane@example.com' });
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([ticket]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await service.listMyTickets('jane@example.com');
      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('passes OR clause covering requesterEmail and user.emails', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listMyTickets('test@example.com');

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array), mergedIntoId: null }),
        }),
      );
    });

    it('returns empty list when no tickets match', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      const result = await service.listMyTickets('nobody@example.com');
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
    it('creates a staff post reply and updates ticket metadata', async () => {
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
        expect.objectContaining({ data: expect.objectContaining({ firstResponseAt: expect.any(Date) }) }),
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
      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(updatedNewTicket);

      const result = await service.split(1, { subject: 'New ticket', postIds: [5, 6] } as any, 5);
      expect(result.mask).toBe('TT-000099');
      expect(prisma.ticket.create).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });
});
