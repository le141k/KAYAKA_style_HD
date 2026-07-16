/**
 * Tests for the client-session ticket service methods (GOAL_PUBLIC_SECURITY S2-7):
 *   - getPublicTicket(id, clientUserId) — ticket + posts only, owner-scoped by userId
 *   - publicReply(id, dto, clientUserId) — USER post, owner-scoped, identity from ticket
 *   - listMyTickets(clientUserId)        — only the verified client's own tickets
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { UsersService } from '../users/users.service';
import type { SlaService } from '../sla/sla.service';
import type { MailService } from '../mail/mail.service';
import type { AdminService } from '../admin/admin.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Ticket, TicketPost } from '@prisma/client';

// The verified-client userId that owns the fixture ticket, and a different client.
const OWNER = 1;
const OTHER_CLIENT = 999;

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
    userId: OWNER,
    requesterName: 'Alice',
    requesterEmail: 'alice@example.com',
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

function makePost(overrides: Partial<TicketPost> = {}): TicketPost {
  return {
    id: 10,
    ticketId: 1,
    authorType: 'USER',
    staffId: null,
    userId: OWNER,
    fullName: 'Alice',
    email: 'alice@example.com',
    subject: 'Test ticket',
    contents: 'Hello, I need help.',
    isHtml: false,
    isEmailed: false,
    isThirdParty: false,
    creationMode: 'WEB',
    ipAddress: '0.0.0.0',
    createdAt: new Date(),
    ...overrides,
  } as TicketPost;
}

function withRelations(ticket: Ticket) {
  return {
    ...ticket,
    posts: [],
    status: null,
    priority: null,
    department: null,
    owner: null,
    user: null,
    tags: [],
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
    user: { findUnique: vi.fn().mockResolvedValue({ organizationId: null }) },
    staff: { findUnique: vi.fn().mockResolvedValue(null) },
    ticketPost: { create: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    ticketNote: { create: vi.fn() },
    ticketStatus: { findFirst: vi.fn(), findUnique: vi.fn() },
    ticketPriority: { findFirst: vi.fn() },
    ticketAuditLog: { create: vi.fn() },
    ticketWatcher: { upsert: vi.fn(), deleteMany: vi.fn() },
    ticketTag: { findUnique: vi.fn() },
    ticketRecipient: {
      findMany: vi.fn().mockResolvedValue([]),
      createMany: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(mock)
        : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  return mock as unknown as PrismaService;
}

describe('TicketsService — client-session endpoints', () => {
  let service: TicketsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    const users = { findOrCreate: vi.fn().mockResolvedValue({ id: 1 }) } as unknown as UsersService;
    const sla = {
      resolvePlanForTicket: vi.fn().mockResolvedValue(null),
      computeDueDates: vi.fn().mockResolvedValue({ dueAt: null, resolutionDueAt: null }),
    } as unknown as SlaService;
    const eventEmitter = { emit: vi.fn() } as unknown as EventEmitter2;
    const mail = { sendTemplate: vi.fn().mockResolvedValue(undefined) } as unknown as MailService;
    const admin = {
      validateCustomFields: vi.fn().mockResolvedValue(undefined),
      encryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
      decryptCustomFields: vi.fn().mockImplementation((_s: unknown, v: unknown) => Promise.resolve(v)),
    } as unknown as AdminService;

    service = new TicketsService(prisma as unknown as PrismaService, users, sla, eventEmitter, mail, admin);
  });

  // ─── getPublicTicket (owner-scoped) ───────────────────────────────────────

  describe('getPublicTicket', () => {
    it('returns the ticket with posts for the owning client', async () => {
      const ticketWithRelations = { ...withRelations(makeTicket()), posts: [makePost()] };
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticketWithRelations);

      const result = await service.getPublicTicket(1, OWNER);

      expect(result.id).toBe(1);
      expect(result.posts).toHaveLength(1);
      expect(result.posts[0]!.contents).toBe('Hello, I need help.');
    });

    it('does NOT include internal notes — only posts', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...withRelations(makeTicket({ hasNotes: true })),
        posts: [makePost()],
      });
      const result = await service.getPublicTicket(1, OWNER);
      expect((result as unknown as Record<string, unknown>)['notes']).toBeUndefined();
      expect(result.posts).toBeDefined();
    });

    it('throws NotFoundException when the ticket does not exist', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getPublicTicket(999, OWNER)).rejects.toThrow(NotFoundException);
    });

    it('does NOT expose the assigned agent email (owner select = id + name only)', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(withRelations(makeTicket()));
      await service.getPublicTicket(1, OWNER);
      const arg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        include: { owner: { select: Record<string, unknown> } };
      };
      expect(arg.include.owner.select).toEqual({ id: true, firstName: true, lastName: true });
      expect(arg.include.owner.select['email']).toBeUndefined();
    });
  });

  // ─── getPublicTicket — ownership / IDOR guards ────────────────────────────

  describe('getPublicTicket — ownership guards', () => {
    it('throws NotFoundException when the ticket belongs to another client (wrong userId)', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        withRelations(makeTicket({ userId: OWNER })),
      );
      await expect(service.getPublicTicket(1, OTHER_CLIENT)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the ticket has no owner (userId null — unmapped)', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        withRelations(makeTicket({ userId: null })),
      );
      await expect(service.getPublicTicket(1, OWNER)).rejects.toThrow(NotFoundException);
    });

    it('posts use a narrow select that omits staff email / ipAddress', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(withRelations(makeTicket()));
      await service.getPublicTicket(1, OWNER);
      const callArg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        include?: { posts?: { select?: Record<string, unknown> } };
      };
      const postsSelect = callArg.include!.posts!.select!;
      expect(postsSelect['contents']).toBe(true);
      expect(postsSelect['email']).toBeUndefined();
      expect(postsSelect['ipAddress']).toBeUndefined();
      expect(postsSelect['staffId']).toBeUndefined();
    });

    it('selects only non-sensitive user fields (never passwordHash)', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(withRelations(makeTicket()));
      await service.getPublicTicket(1, OWNER);
      const callArg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        include?: { user?: { select?: Record<string, unknown>; include?: unknown } };
      };
      const userClause = callArg.include!.user!;
      expect(userClause.select).toBeDefined();
      expect(userClause.include).toBeUndefined();
      expect(userClause.select!['passwordHash']).toBeUndefined();
    });
  });

  // ─── publicReply (owner-scoped) ───────────────────────────────────────────

  describe('publicReply', () => {
    function armReplyMocks(ticket: Ticket) {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(makePost());
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
    }

    it("creates a USER post on the owning client's ticket", async () => {
      armReplyMocks(makeTicket());
      const result = await service.publicReply(1, { contents: 'Follow-up from client' }, OWNER);
      expect(result).toBeTruthy();
      expect(prisma.ticketPost.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authorType: 'USER',
            staffId: null,
            contents: 'Follow-up from client',
          }),
        }),
      );
    });

    it('attributes the post from the TICKET, not the request body', async () => {
      armReplyMocks(makeTicket({ requesterEmail: 'alice@example.com' }));
      await service.publicReply(1, { contents: 'Reply' }, OWNER);
      expect(prisma.ticketPost.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'alice@example.com' }) }),
      );
    });

    it('increments totalReplies on the ticket', async () => {
      armReplyMocks(makeTicket());
      await service.publicReply(1, { contents: 'Reply' }, OWNER);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ totalReplies: { increment: 1 } }) }),
      );
    });

    it('throws NotFoundException when the ticket does not exist', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.publicReply(999, { contents: 'Hi' }, OWNER)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when replying to another client's ticket (IDOR guard)", async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket({ userId: OWNER }));
      await expect(service.publicReply(1, { contents: 'Hi' }, OTHER_CLIENT)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.ticketPost.create).not.toHaveBeenCalled();
    });

    it('H8-3: rejects attachmentIds without a claimToken (no unscoped orphan adoption)', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(makeTicket());
      await expect(
        service.publicReply(1, { contents: 'Here is the file', attachmentIds: [10] }, OWNER),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.ticketPost.create).not.toHaveBeenCalled();
    });

    it('reopens a resolved ticket on a user reply (reset to default status)', async () => {
      armReplyMocks(makeTicket({ isResolved: true }));
      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });
      await service.publicReply(1, { contents: 'Still broken' }, OWNER);
      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ statusId: 7, isResolved: false, resolvedAt: null }),
        }),
      );
    });
  });

  // ─── listMyTickets (owner-scoped) ─────────────────────────────────────────

  describe('listMyTickets', () => {
    it('queries strictly by the verified client userId', async () => {
      (prisma.ticket.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

      await service.listMyTickets(OWNER);

      expect(prisma.ticket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { mergedIntoId: null, userId: OWNER } }),
      );
    });
  });
});
