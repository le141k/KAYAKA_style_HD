import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { formatTicketMask } from './ticket-mask.util';
import type { PrismaService } from '../../prisma/prisma.service';
import type { UsersService } from '../users/users.service';
import type { SlaService } from '../sla/sla.service';
import type { MailService } from '../mail/mail.service';
import type { AdminService } from '../admin/admin.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Ticket } from '@prisma/client';

// ─── Mask util unit tests ───────────────────────────────────────────────────

describe('formatTicketMask', () => {
  it('pads to 6 digits', () => {
    expect(formatTicketMask(1)).toBe('TT-000001');
    expect(formatTicketMask(42)).toBe('TT-000042');
    expect(formatTicketMask(123456)).toBe('TT-123456');
  });

  it('handles numbers larger than 6 digits', () => {
    expect(formatTicketMask(1234567)).toBe('TT-1234567');
  });
});

// ─── Ticket service unit tests ──────────────────────────────────────────────

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
    ticketPost: {
      create: vi.fn(),
      updateMany: vi.fn(),
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
      findUnique: vi.fn(),
    },
    ticketPriority: {
      findFirst: vi.fn(),
    },
    ticketAuditLog: {
      create: vi.fn(),
    },
    staff: {
      // E3: assign/bulkAction validate the assignee exists + is enabled.
      findUnique: vi.fn().mockResolvedValue({ id: 5, isEnabled: true }),
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
    ticketRecipient: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({}),
    },
    // Default: interactive ($transaction(cb)) form runs the callback against this
    // same mock; array form resolves the array of promises.
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

describe('TicketsService', () => {
  let service: TicketsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let users: UsersService;

  beforeEach(() => {
    prisma = makePrismaMock();
    users = makeUsersMock();
    const slaMock = {
      resolvePlanForTicket: vi.fn().mockResolvedValue(null),
      computeDueDates: vi.fn().mockResolvedValue({ dueAt: null, resolutionDueAt: null }),
    } as unknown as SlaService;
    const eventEmitterMock = { emit: vi.fn() } as unknown as EventEmitter2;
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
    service = new TicketsService(
      prisma as unknown as PrismaService,
      users,
      slaMock,
      eventEmitterMock,
      mailMock,
      adminMock,
    );
  });

  // ─── createTicket ─────────────────────────────────────────────────────────

  describe('createTicket', () => {
    it('resolves default status and priority, creates ticket and updates mask', async () => {
      const mockTicket = makeTicket({ id: 42 });

      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      (prisma.ticketPriority.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 2 });
      (prisma.ticket.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockTicket);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockTicket,
        mask: 'TT-000042',
      });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.createTicket(
        {
          subject: 'Test',
          contents: 'Body',
          isHtml: false,
          departmentId: 1,
          requesterEmail: 'test@example.com',
          requesterName: 'Test User',
          creationMode: 'STAFF',
          ipAddress: '127.0.0.1',
          tags: [],
          customFields: {},
        },
        10,
      );

      expect(result.mask).toBe('TT-000042');
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { mask: 'TT-000042' } }),
      );
    });

    it('creates the ticket and assigns its mask inside a single $transaction (no race)', async () => {
      const mockTicket = makeTicket({ id: 42, mask: 'TT-PENDING' });

      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      (prisma.ticketPriority.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 2 });
      (prisma.ticket.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockTicket);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockTicket,
        mask: 'TT-000042',
      });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.createTicket({
        subject: 'Race',
        contents: 'Body',
        isHtml: false,
        departmentId: 1,
        requesterEmail: 'test@example.com',
        requesterName: 'Test',
        creationMode: 'WEB',
        ipAddress: '0.0.0.0',
        tags: [],
        customFields: {},
      });

      // Both the create (TT-PENDING) and the mask update must run via $transaction
      expect(prisma.$transaction).toHaveBeenCalled();
      const txArg = (prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(typeof txArg).toBe('function');
    });

    it('throws if no default status is configured', async () => {
      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.ticketPriority.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });

      await expect(
        service.createTicket({
          subject: 'Test',
          contents: 'Body',
          isHtml: false,
          departmentId: 1,
          requesterEmail: 'test@example.com',
          requesterName: 'Test',
          creationMode: 'WEB',
          ipAddress: '0.0.0.0',
          tags: [],
          customFields: {},
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── assign ───────────────────────────────────────────────────────────────

  describe('assign', () => {
    it('updates ownerStaffId and writes audit log', async () => {
      const ticket = makeTicket({ ownerStaffId: null });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...ticket,
        ownerStaffId: 5,
      });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.assign(1, { ownerStaffId: 5 }, 99);

      expect(result.ownerStaffId).toBe(5);
      expect(prisma.ticketAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'ASSIGN',
            field: 'ownerStaffId',
            newValue: '5',
          }),
        }),
      );
    });
  });

  // ─── recipient upsert (createTicket cc/bcc) ──────────────────────────────

  describe('createTicket with cc/bcc', () => {
    it('saves CC and BCC recipients after ticket creation', async () => {
      const mockTicket = makeTicket({ id: 42 });

      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 1 });
      (prisma.ticketPriority.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 2 });
      (prisma.ticket.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockTicket);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...mockTicket,
        mask: 'TT-000042',
      });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.createTicket({
        subject: 'Test',
        contents: 'Body',
        isHtml: false,
        departmentId: 1,
        requesterEmail: 'test@example.com',
        requesterName: 'Test User',
        creationMode: 'STAFF',
        ipAddress: '127.0.0.1',
        tags: [],
        customFields: {},
        ccEmails: ['cc@example.com'],
        bccEmails: ['bcc@example.com'],
      });

      expect(prisma.ticketRecipient.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.arrayContaining([
            expect.objectContaining({ email: 'cc@example.com', role: 'CC' }),
            expect.objectContaining({ email: 'bcc@example.com', role: 'BCC' }),
          ]),
        }),
      );
    });
  });

  // ─── changeStatus ─────────────────────────────────────────────────────────

  describe('changeStatus', () => {
    it('marks ticket as resolved when status has markAsResolved=true', async () => {
      const ticket = makeTicket({ statusId: 1, isResolved: false });
      const resolvedStatus = { id: 4, markAsResolved: true };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketStatus.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(resolvedStatus);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...ticket,
        statusId: 4,
        isResolved: true,
      });
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.changeStatus(1, { statusId: 4 }, 99);
      expect(result.isResolved).toBe(true);
    });

    it('throws NotFoundException when ticket does not exist', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.changeStatus(999, { statusId: 1 }, 1)).rejects.toThrow(NotFoundException);
    });
  });

  // ─── merge ────────────────────────────────────────────────────────────────

  describe('merge', () => {
    it('throws BadRequestException when merging into itself', async () => {
      const ticket = makeTicket({ id: 1 });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await expect(service.merge(1, { targetTicketId: 1 }, 99)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when source is already merged', async () => {
      const source = makeTicket({ id: 1, mergedIntoId: 2 });
      const target = makeTicket({ id: 2, mergedIntoId: null });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(target);

      await expect(service.merge(1, { targetTicketId: 2 }, 99)).rejects.toThrow(BadRequestException);
    });

    it('moves posts and updates mergedIntoId on success', async () => {
      const source = makeTicket({ id: 1, mask: 'TT-000001', totalReplies: 2, mergedIntoId: null });
      const target = makeTicket({ id: 2, mask: 'TT-000002', totalReplies: 3, mergedIntoId: null });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(source)
        .mockResolvedValueOnce(target);

      (prisma.$transaction as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticket.findUniqueOrThrow as ReturnType<typeof vi.fn>).mockResolvedValue(target);

      const result = await service.merge(1, { targetTicketId: 2 }, 99);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(result.id).toBe(2);
    });
  });
});
