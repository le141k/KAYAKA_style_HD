/**
 * Tests for the public (unauthenticated) ticket service methods:
 *   - getPublicTicket  — returns ticket + posts only (no notes exposed)
 *   - publicReply      — creates a USER post without requiring staffId
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

// ─── helpers ────────────────────────────────────────────────────────────────

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
    userId: 1,
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
      findUnique: vi.fn().mockResolvedValue(null),
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
      findUnique: vi.fn(),
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

// ─── suite ──────────────────────────────────────────────────────────────────

describe('TicketsService — public endpoints', () => {
  let service: TicketsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    const users = {
      findOrCreate: vi.fn().mockResolvedValue({ id: 1 }),
    } as unknown as UsersService;
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
      decryptCustomFieldsMany: vi
        .fn()
        .mockImplementation((_s: unknown, rows: unknown) => Promise.resolve(rows)),
    } as unknown as AdminService;

    service = new TicketsService(prisma as unknown as PrismaService, users, sla, eventEmitter, mail, admin);
  });

  // ─── getPublicTicket ──────────────────────────────────────────────────────

  describe('getPublicTicket', () => {
    it('returns ticket with posts when found', async () => {
      const ticket = makeTicket();
      const post = makePost();
      const ticketWithRelations = {
        ...ticket,
        posts: [post],
        status: { id: 1, title: 'Open' },
        priority: { id: 1, title: 'Normal' },
        department: { id: 1, title: 'Support' },
        owner: null,
        user: null,
        tags: [],
      };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticketWithRelations);

      const result = await service.getPublicTicket(1, 'alice@example.com');

      expect(result.id).toBe(1);
      expect(result.posts).toHaveLength(1);
      expect(result.posts[0]!.contents).toBe('Hello, I need help.');
    });

    it('does NOT expose the assigned agent email (owner select = id + name only)', async () => {
      const ticketWithRelations = {
        ...makeTicket(),
        posts: [],
        status: null,
        priority: null,
        department: null,
        owner: null,
        user: null,
        tags: [],
      };
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticketWithRelations);

      await service.getPublicTicket(1, 'alice@example.com');

      const arg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        include: { owner: { select: Record<string, unknown> } };
      };
      expect(arg.include.owner.select).toEqual({ id: true, firstName: true, lastName: true });
      expect(arg.include.owner.select['email']).toBeUndefined();
    });

    it('does NOT include internal notes — only posts are returned', async () => {
      const ticket = makeTicket({ hasNotes: true });
      const post = makePost();
      // The DB query intentionally omits notes; simulate by returning no notes field
      const ticketWithRelations = {
        ...ticket,
        posts: [post],
        status: null,
        priority: null,
        department: null,
        owner: null,
        user: null,
        tags: [],
        // notes are NOT part of the returned object
      };

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticketWithRelations);

      const result = await service.getPublicTicket(1, 'alice@example.com');

      // Confirm 'notes' is not present on the public result
      expect((result as unknown as Record<string, unknown>)['notes']).toBeUndefined();
      expect(result.posts).toBeDefined();
    });

    it('throws NotFoundException when ticket does not exist', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.getPublicTicket(999)).rejects.toThrow(NotFoundException);
    });

    it('queries the DB without including notes', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...ticket,
        posts: [],
        status: null,
        priority: null,
        department: null,
        owner: null,
        user: null,
        tags: [],
      });

      await service.getPublicTicket(1, 'alice@example.com');

      // Verify that the findUnique call does NOT include 'notes' in its include object
      const callArg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        include?: Record<string, unknown>;
      };
      expect(callArg.include).toBeDefined();
      expect(callArg.include!['notes']).toBeUndefined();
    });
  });

  // ─── publicReply ──────────────────────────────────────────────────────────

  describe('publicReply', () => {
    it('creates a USER post on an existing ticket', async () => {
      const ticket = makeTicket();
      const post = makePost({ authorType: 'USER', staffId: null });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(post);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.publicReply(1, {
        contents: 'Follow-up from client',
        requesterEmail: 'alice@example.com',
      });

      expect(result).toBe(post);
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

    it('uses dto.requesterEmail when provided', async () => {
      // The supplied email must be one the requester owns (ownership check) —
      // here it is a secondary email linked to the ticket's user.
      const ticket = {
        ...makeTicket({ requesterEmail: 'alice@example.com' }),
        user: { emails: [{ email: 'alice+new@example.com' }] },
      };
      const post = makePost({ email: 'alice+new@example.com' });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(post);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.publicReply(1, {
        contents: 'Reply',
        requesterEmail: 'alice+new@example.com',
      });

      expect(prisma.ticketPost.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'alice+new@example.com' }),
        }),
      );
    });

    it('attributes the post to the matching requester email', async () => {
      const ticket = makeTicket({ requesterEmail: 'alice@example.com' });
      const post = makePost();

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(post);
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.publicReply(1, { contents: 'Another reply', requesterEmail: 'alice@example.com' });

      expect(prisma.ticketPost.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'alice@example.com' }),
        }),
      );
    });

    it('increments totalReplies on the ticket', async () => {
      const ticket = makeTicket();

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(makePost());
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      await service.publicReply(1, { contents: 'Reply', requesterEmail: 'alice@example.com' });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            totalReplies: { increment: 1 },
          }),
        }),
      );
    });

    it('throws NotFoundException when ticket does not exist', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(
        service.publicReply(999, { contents: 'Hi', requesterEmail: 'alice@example.com' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('H8-3: rejects attachmentIds without a claimToken (no unscoped orphan adoption)', async () => {
      const ticket = makeTicket({ requesterEmail: 'alice@example.com' });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await expect(
        service.publicReply(1, {
          contents: 'Here is the file',
          requesterEmail: 'alice@example.com',
          attachmentIds: [10],
          // no attachmentClaimToken
        }),
      ).rejects.toThrow(BadRequestException);
      // The post must NOT have been created.
      expect(prisma.ticketPost.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when requesterEmail does not match the ticket (IDOR guard)', async () => {
      const ticket = makeTicket({ requesterEmail: 'alice@example.com' });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);

      await expect(
        service.publicReply(1, { contents: 'Hi', requesterEmail: 'mallory@evil.com' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('reopens a resolved ticket on a user reply (reset to default status)', async () => {
      const ticket = makeTicket({ requesterEmail: 'alice@example.com', isResolved: true });

      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketPost.create as ReturnType<typeof vi.fn>).mockResolvedValue(makePost());
      (prisma.ticket.update as ReturnType<typeof vi.fn>).mockResolvedValue(ticket);
      (prisma.ticketAuditLog.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.ticketStatus.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 7 });

      await service.publicReply(1, { contents: 'Still broken', requesterEmail: 'alice@example.com' });

      expect(prisma.ticket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            statusId: 7,
            isResolved: false,
            resolvedAt: null,
          }),
        }),
      );
    });
  });

  // ─── getPublicTicket — IDOR / data-leak guards ────────────────────────────

  describe('getPublicTicket — IDOR guards', () => {
    it('throws NotFoundException when no email is supplied', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...ticket,
        posts: [],
        status: null,
        priority: null,
        department: null,
        owner: null,
        user: null,
        tags: [],
      });

      await expect(service.getPublicTicket(1)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the email does not match the ticket', async () => {
      const ticket = makeTicket({ requesterEmail: 'alice@example.com' });
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...ticket,
        posts: [],
        status: null,
        priority: null,
        department: null,
        owner: null,
        user: null,
        tags: [],
      });

      await expect(service.getPublicTicket(1, 'mallory@evil.com')).rejects.toThrow(NotFoundException);
    });

    it('SEC-3b: posts use a narrow select that omits staff email / ipAddress', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...ticket,
        posts: [],
        status: null,
        priority: null,
        department: null,
        owner: null,
        user: null,
        tags: [],
      });

      await service.getPublicTicket(1, 'alice@example.com');

      const callArg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        include?: { posts?: { select?: Record<string, unknown> } };
      };
      const postsSelect = callArg.include!.posts!.select!;
      // Client-facing fields are allowed; internal/PII fields must NOT be projected.
      expect(postsSelect).toBeDefined();
      expect(postsSelect['contents']).toBe(true);
      expect(postsSelect['fullName']).toBe(true);
      expect(postsSelect['email']).toBeUndefined();
      expect(postsSelect['ipAddress']).toBeUndefined();
      expect(postsSelect['staffId']).toBeUndefined();
      expect(postsSelect['messageId']).toBeUndefined();
    });

    it('selects only non-sensitive user fields (never passwordHash)', async () => {
      const ticket = makeTicket();
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...ticket,
        posts: [],
        status: null,
        priority: null,
        department: null,
        owner: null,
        user: null,
        tags: [],
      });

      await service.getPublicTicket(1, 'alice@example.com');

      const callArg = (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        include?: { user?: { select?: Record<string, unknown>; include?: unknown } };
      };
      const userClause = callArg.include!.user!;
      // Must use a narrow `select`, never `include` (which would pull passwordHash)
      expect(userClause.select).toBeDefined();
      expect(userClause.include).toBeUndefined();
      expect(userClause.select!['passwordHash']).toBeUndefined();
      expect(userClause.select!['id']).toBe(true);
      expect(userClause.select!['fullName']).toBe(true);
    });
  });
});
