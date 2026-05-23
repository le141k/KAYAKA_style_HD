import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { SlaService } from '../sla/sla.service';
import { MailService } from '../mail/mail.service';
import { AdminService } from '../admin/admin.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { NotificationService } from './notification.service';
import { formatTicketMask } from './ticket-mask.util';
import type {
  CreateTicketDto,
  ReplyTicketDto,
  AssignTicketDto,
  ChangeStatusDto,
  ChangePriorityDto,
  ChangeTypeDto,
  MergeTicketDto,
  SplitTicketDto,
  ListTicketsQueryDto,
  TagDto,
  WatcherDto,
  PublicReplyDto,
  ApplyMacroDto,
  ChangeDepartmentDto,
} from './dto';
import type { ActorType, CreationMode, Ticket, TicketPost, TicketNote } from '@prisma/client';

/** Rich ticket view returned by getTicket. */
export interface TicketDetail extends Ticket {
  posts: TicketPost[];
  notes: TicketNote[];
  watchers: Array<{ staffId: number }>;
  tags: Array<{ name: string }>;
}

/** Public ticket view — posts only, no notes. */
export interface PublicTicketDetail extends Ticket {
  posts: TicketPost[];
  status: { id: number; title: string } | null;
  priority: { id: number; title: string } | null;
  department: { id: number; title: string } | null;
  owner: { id: number; firstName: string; lastName: string; email: string } | null;
  user: { id: number; fullName: string; emails: { email: string; isPrimary: boolean }[] } | null;
  tags: Array<{ name: string }>;
}

/** Non-sensitive user fields exposed on public ticket views (never passwordHash). */
const PUBLIC_USER_SELECT = {
  id: true,
  fullName: true,
  emails: { select: { email: true, isPrimary: true } },
} as const;

@Injectable()
export class TicketsService {
  private readonly logger = new Logger(TicketsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly slaService: SlaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly mailService: MailService,
    private readonly adminService: AdminService,
    @Optional() private readonly attachmentsService?: AttachmentsService,
    @Optional() private readonly notificationService?: NotificationService,
  ) {}

  // ─────────────────────────── Create ───────────────────────────

  async createTicket(dto: CreateTicketDto, creatorStaffId?: number): Promise<Ticket> {
    // Validate custom fields against TICKET scope definitions
    if (dto.customFields && typeof dto.customFields === 'object') {
      await this.adminService.validateCustomFields('TICKET', dto.customFields as Record<string, unknown>);
    }

    // Resolve or create the requester user
    let userId = dto.userId;
    if (!userId) {
      const user = await this.usersService.findOrCreate(
        dto.requesterEmail,
        dto.requesterName || dto.requesterEmail,
      );
      userId = user.id;
    }

    // Resolve the SLA plan for the ticket (based on org or default)
    const userWithOrg = userId
      ? await this.prisma.user.findUnique({ where: { id: userId }, select: { organizationId: true } })
      : null;
    const orgId = userWithOrg?.organizationId ?? null;

    const slaPlanId = dto.slaPlanId ?? (await this.slaService.resolvePlanForTicket(orgId));

    // Resolve default status / priority if not supplied
    const statusId = dto.statusId ?? (await this.defaultStatusId());
    const priorityId = dto.priorityId ?? (await this.defaultPriorityId());

    const creatorActor: ActorType = creatorStaffId ? 'STAFF' : 'USER';

    const now = new Date();

    // Compute SLA due dates if a plan was resolved
    let dueAt: Date | null = null;
    let resolutionDueAt: Date | null = null;
    if (slaPlanId) {
      const dueDates = await this.slaService.computeDueDates(slaPlanId, now);
      dueAt = dueDates.dueAt;
      resolutionDueAt = dueDates.resolutionDueAt;
    }

    // Create ticket + assign its mask atomically. The mask is derived from the
    // auto-increment id, so we create first (temp mask) then update within a
    // single $transaction to avoid a window where a TT-PENDING mask is visible.
    const [, updated] = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ticket.create({
        data: {
          mask: 'TT-PENDING', // temporary; replaced within this same transaction
          subject: dto.subject,
          departmentId: dto.departmentId,
          statusId,
          priorityId,
          typeId: dto.typeId,
          userId,
          requesterEmail: dto.requesterEmail,
          requesterName: dto.requesterName,
          ownerStaffId: dto.ownerStaffId,
          slaPlanId,
          dueAt,
          resolutionDueAt,
          creationMode: dto.creationMode as CreationMode,
          creator: creatorActor,
          ipAddress: dto.ipAddress,
          customFields: dto.customFields as object,
          // First post
          posts: {
            create: {
              authorType: creatorActor,
              staffId: creatorStaffId,
              userId,
              fullName: dto.requesterName,
              email: dto.requesterEmail,
              subject: dto.subject,
              contents: dto.contents,
              isHtml: dto.isHtml,
              creationMode: dto.creationMode as CreationMode,
              ipAddress: dto.ipAddress,
            },
          },
          // Tags
          tags: dto.tags.length
            ? {
                connectOrCreate: dto.tags.map((name) => ({
                  where: { name },
                  create: { name },
                })),
              }
            : undefined,
          totalReplies: 1,
        },
      });

      const updatedTicket = await tx.ticket.update({
        where: { id: created.id },
        data: { mask: formatTicketMask(created.id) },
      });

      return [created, updatedTicket] as const;
    });

    const ticket = updated;
    const mask = updated.mask;

    // Link attachment orphans to the first post (if any attachmentIds were supplied)
    if (dto.attachmentIds?.length && this.attachmentsService) {
      const firstPost = await this.prisma.ticketPost.findFirst({
        where: { ticketId: ticket.id },
        orderBy: { id: 'asc' },
      });
      if (firstPost) {
        await this.attachmentsService.linkToPost(dto.attachmentIds, firstPost.id, ticket.id);
        await this.prisma.ticket.update({ where: { id: ticket.id }, data: { hasAttachments: true } });
      }
    }

    // Persist CC/BCC recipients
    const allRecipients = [
      ...(dto.ccEmails ?? []).map((email) => ({ email, role: 'CC' as const })),
      ...(dto.bccEmails ?? []).map((email) => ({ email, role: 'BCC' as const })),
    ];
    if (allRecipients.length > 0) {
      await this.prisma.ticketRecipient.createMany({
        data: allRecipients.map((r) => ({ ticketId: ticket.id, email: r.email, role: r.role })),
        skipDuplicates: true,
      });
    }

    // Write audit log
    await this.writeAudit(ticket.id, 'CREATE', creatorStaffId, creatorActor, {
      newValue: mask,
    });

    this.logger.log(`Ticket ${mask} created`);

    // Emit domain event
    this.emitDomainEvent('ticket.created', updated.id);

    // Send autoresponder email to requester (non-blocking).
    // Skip for system-generated tickets (e.g. Alaris) — their requesterEmail is a
    // non-deliverable internal address and should not receive an autoresponder.
    const isSystemTicket = dto.creationMode === 'ALARIS';
    if (dto.requesterEmail && !isSystemTicket) {
      const requesterName = dto.requesterName || dto.requesterEmail;
      this.mailService
        .sendTemplate(dto.requesterEmail, 'autoresponder', 'en', {
          mask,
          subject: dto.subject,
          contents: dto.contents,
          // Templates reference {{name}}; keep requesterName too for forward-compat.
          name: requesterName,
          requesterName,
        })
        .catch((err: unknown) => this.logger.error(`Autoresponder email failed for ${mask}: ${String(err)}`));
    }

    return updated;
  }

  // ─────────────────────────── Client: my tickets ───────────────────────────

  /**
   * Return tickets for a given requester email address.
   * Matches requesterEmail directly OR any UserEmail linked to a User row.
   * Used by the client-facing "my tickets" page (@Public endpoint).
   */
  async listMyTickets(requesterEmail: string): Promise<{ data: Ticket[]; total: number }> {
    // Build OR clause: direct requesterEmail OR through the user's emails
    const where = {
      mergedIntoId: null,
      OR: [
        { requesterEmail: { equals: requesterEmail, mode: 'insensitive' as const } },
        {
          user: {
            emails: {
              some: { email: { equals: requesterEmail, mode: 'insensitive' as const } },
            },
          },
        },
      ],
    };

    const [data, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: {
          status: true,
          priority: true,
          type: true,
          department: true,
        },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { data, total };
  }

  // ─────────────────────────── Public ticket detail (client portal) ──────────

  /**
   * Returns a single ticket with its posts only — internal notes are
   * NEVER included.  Shape mirrors getTicket() but omits notes/watchers/auditLogs.
   * Used by the @Public GET /tickets/public/:id endpoint.
   */
  async getPublicTicket(id: number, requesterEmail?: string): Promise<PublicTicketDetail> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        status: { select: { id: true, title: true } },
        priority: { select: { id: true, title: true } },
        department: { select: { id: true, title: true } },
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        // Narrow select — NEVER expose passwordHash or other sensitive user fields
        user: { select: PUBLIC_USER_SELECT },
        // Only posts (USER/STAFF replies) — notes are intentionally excluded
        posts: {
          orderBy: { createdAt: 'asc' },
        },
        tags: { select: { name: true } },
      },
    });

    if (!ticket) throw new NotFoundException(`Ticket ${id} not found`);

    // Ownership check: a public ticket is enumerable by integer id, so the caller
    // must prove they own it by supplying the matching requester email.
    this.assertRequesterOwnsTicket(ticket, requesterEmail);

    return ticket as unknown as PublicTicketDetail;
  }

  /**
   * Verify the supplied email matches the ticket's requester (direct
   * requesterEmail OR any of the linked user's emails). Throws NotFoundException
   * (not Forbidden) so callers cannot distinguish "wrong email" from
   * "no such ticket" and enumerate valid ids.
   */
  private assertRequesterOwnsTicket(
    ticket: {
      id: number;
      requesterEmail: string | null;
      user?: { emails?: { email: string }[] } | null;
    },
    requesterEmail?: string,
  ): void {
    if (!requesterEmail) {
      throw new NotFoundException(`Ticket ${ticket.id} not found`);
    }
    const supplied = requesterEmail.trim().toLowerCase();
    const owned = new Set<string>();
    if (ticket.requesterEmail) owned.add(ticket.requesterEmail.toLowerCase());
    for (const e of ticket.user?.emails ?? []) {
      if (e.email) owned.add(e.email.toLowerCase());
    }
    if (!owned.has(supplied)) {
      throw new NotFoundException(`Ticket ${ticket.id} not found`);
    }
  }

  // ─────────────────────────── Public reply (client portal) ────────────────

  /**
   * Creates a USER post on behalf of the requester.
   * Does not require authentication — identity is taken from the ticket's
   * own requesterName / requesterEmail fields (or the optional dto fields).
   * Internal notes are never involved.
   */
  async publicReply(ticketId: number, dto: PublicReplyDto): Promise<TicketPost> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: { user: { select: { emails: { select: { email: true } } } } },
    });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);

    // Ownership check: the requester must supply a matching email so a random
    // integer id cannot be used to post on someone else's ticket.
    this.assertRequesterOwnsTicket(ticket, dto.requesterEmail);

    const now = new Date();

    const post = await this.prisma.ticketPost.create({
      data: {
        ticketId,
        authorType: 'USER',
        staffId: null,
        userId: ticket.userId,
        fullName: ticket.requesterName ?? undefined,
        email: dto.requesterEmail ?? ticket.requesterEmail ?? undefined,
        subject: ticket.subject,
        contents: dto.contents,
        isHtml: false,
        creationMode: 'WEB',
        ipAddress: '0.0.0.0',
      },
    });

    // Link attachment orphans to the new post
    const hasPublicAttachments = !!(dto.attachmentIds?.length && this.attachmentsService);
    if (hasPublicAttachments && this.attachmentsService) {
      await this.attachmentsService.linkToPost(dto.attachmentIds!, post.id, ticketId);
    }

    // Reopen the ticket if it was resolved — a customer reply must re-surface it
    // to staff. Reset to the default status and clear resolved markers.
    const reopenData = ticket.isResolved
      ? {
          statusId: await this.defaultStatusId(),
          isResolved: false,
          resolvedAt: null,
          reopenedAt: now,
          wasReopened: true,
        }
      : {};

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        totalReplies: { increment: 1 },
        lastReplyAt: now,
        lastActivityAt: now,
        ...(hasPublicAttachments && { hasAttachments: true }),
        ...reopenData,
      },
    });

    await this.writeAudit(ticketId, 'REPLY', undefined, 'USER', {});
    this.emitDomainEvent('ticket.replied', ticketId);

    return post;
  }

  // ─────────────────────────── List ───────────────────────────

  async listTickets(query: ListTicketsQueryDto): Promise<{ data: Ticket[]; total: number }> {
    const { page, limit, sortBy, sortDir, unassigned, search, ...filters } = query;

    const where: Record<string, unknown> = {};

    if (filters.statusId !== undefined) where['statusId'] = filters.statusId;
    if (filters.priorityId !== undefined) where['priorityId'] = filters.priorityId;
    if (filters.departmentId !== undefined) where['departmentId'] = filters.departmentId;
    if (filters.typeId !== undefined) where['typeId'] = filters.typeId;
    if (filters.userId !== undefined) where['userId'] = filters.userId;
    if (filters.isResolved !== undefined) where['isResolved'] = filters.isResolved;

    if (filters.ownerStaffId !== undefined) where['ownerStaffId'] = filters.ownerStaffId;
    if (unassigned) where['ownerStaffId'] = null;

    if (filters.createdAfter || filters.createdBefore) {
      where['createdAt'] = {
        ...(filters.createdAfter ? { gte: filters.createdAfter } : {}),
        ...(filters.createdBefore ? { lte: filters.createdBefore } : {}),
      };
    }

    if (search) {
      where['OR'] = [
        { subject: { contains: search, mode: 'insensitive' } },
        { mask: { contains: search } },
        { requesterEmail: { contains: search, mode: 'insensitive' } },
        { requesterName: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Exclude merged-away tickets from the main list
    where['mergedIntoId'] = null;

    const [data, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { [sortBy]: sortDir },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          status: true,
          priority: true,
          type: true,
          department: true,
          owner: { select: { id: true, firstName: true, lastName: true, email: true } },
          user: { select: PUBLIC_USER_SELECT },
        },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    return { data, total };
  }

  // ─────────────────────────── Get ───────────────────────────

  async getTicket(id: number): Promise<TicketDetail> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        status: true,
        priority: true,
        type: true,
        department: true,
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        user: { select: PUBLIC_USER_SELECT },
        posts: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachments: true,
            staff: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        notes: {
          orderBy: { createdAt: 'asc' },
          include: { staff: { select: { firstName: true, lastName: true, email: true } } },
        },
        attachments: true,
        watchers: { select: { staffId: true } },
        tags: { select: { name: true } },
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 50 },
        recipients: { orderBy: { addedAt: 'asc' } },
      },
    });

    if (!ticket) throw new NotFoundException(`Ticket ${id} not found`);
    return ticket as unknown as TicketDetail;
  }

  async getTicketByMask(mask: string): Promise<TicketDetail> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { mask },
      include: {
        status: true,
        priority: true,
        type: true,
        department: true,
        owner: { select: { id: true, firstName: true, lastName: true, email: true } },
        user: { select: PUBLIC_USER_SELECT },
        posts: {
          orderBy: { createdAt: 'asc' },
          include: {
            attachments: true,
            staff: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        notes: { orderBy: { createdAt: 'asc' } },
        attachments: true,
        watchers: { select: { staffId: true } },
        tags: { select: { name: true } },
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });

    if (!ticket) throw new NotFoundException(`Ticket ${mask} not found`);
    return ticket as unknown as TicketDetail;
  }

  // ─────────────────────────── Reply ───────────────────────────

  async reply(ticketId: number, dto: ReplyTicketDto, staffId?: number): Promise<TicketPost | TicketNote> {
    const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);

    if (dto.isNote) {
      return this.addNote(ticketId, dto.contents, staffId ?? undefined);
    }

    const now = new Date();
    const isStaffReply = !!staffId;
    const firstResponse = isStaffReply && ticket.firstResponseAt === null;

    // Capture the author's display name/email on the post so the thread shows
    // who replied (previously left blank → rendered as "—").
    let authorName: string | undefined;
    let authorEmail: string | undefined;
    if (isStaffReply && staffId) {
      const staff = await this.prisma.staff.findUnique({ where: { id: staffId } });
      if (staff) {
        authorName = `${staff.firstName} ${staff.lastName}`.trim() || staff.email;
        authorEmail = staff.email;
      }
    } else {
      authorName = ticket.requesterName ?? undefined;
      authorEmail = ticket.requesterEmail ?? undefined;
    }

    const post = await this.prisma.ticketPost.create({
      data: {
        ticketId,
        authorType: isStaffReply ? 'STAFF' : 'USER',
        staffId,
        fullName: authorName,
        email: authorEmail,
        subject: ticket.subject,
        contents: dto.contents,
        isHtml: dto.isHtml,
        isEmailed: dto.isEmailed,
        isThirdParty: dto.isThirdParty,
        creationMode: dto.creationMode as CreationMode,
        ipAddress: dto.ipAddress,
      },
    });

    // Link attachment orphans to the new post
    const hasNewAttachments = !!(dto.attachmentIds?.length && this.attachmentsService);
    if (hasNewAttachments && this.attachmentsService) {
      await this.attachmentsService.linkToPost(dto.attachmentIds!, post.id, ticketId);
    }

    // Reopen the ticket when a USER (customer) replies to a resolved/closed
    // ticket so it re-surfaces to staff. Staff replies must NOT reopen.
    const reopenData =
      !isStaffReply && ticket.isResolved
        ? {
            statusId: await this.defaultStatusId(),
            isResolved: false,
            resolvedAt: null,
            reopenedAt: now,
            wasReopened: true,
          }
        : {};

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        totalReplies: { increment: 1 },
        lastReplyAt: now,
        lastActivityAt: now,
        // Mark first staff response time if not yet set
        ...(firstResponse && { firstResponseAt: now }),
        // Set hasAttachments if new attachments were linked
        ...(hasNewAttachments && { hasAttachments: true }),
        ...reopenData,
      },
    });

    await this.writeAudit(ticketId, 'REPLY', staffId ?? undefined, isStaffReply ? 'STAFF' : 'USER', {});

    // Send outbound email to requester when a staff member replies (non-blocking)
    if (isStaffReply && ticket.requesterEmail) {
      const requesterName = ticket.requesterName || ticket.requesterEmail;
      // Load CC/BCC recipients for this ticket
      const recipients = await this.prisma.ticketRecipient.findMany({ where: { ticketId } });
      const ccEmails = [
        ...(dto.ccEmails ?? []),
        ...recipients.filter((r) => r.role === 'CC').map((r) => r.email),
      ];
      const bccEmails = [
        ...(dto.bccEmails ?? []),
        ...recipients.filter((r) => r.role === 'BCC').map((r) => r.email),
      ];
      this.mailService
        .sendTemplate(
          ticket.requesterEmail,
          'ticket_user_reply',
          'en',
          {
            mask: ticket.mask,
            subject: ticket.subject,
            contents: dto.contents,
            // Templates reference {{name}}; keep requesterName too for forward-compat.
            name: requesterName,
            requesterName,
          },
          {
            cc: ccEmails.length > 0 ? ccEmails : undefined,
            bcc: bccEmails.length > 0 ? bccEmails : undefined,
          },
        )
        .catch((err: unknown) =>
          this.logger.error(`Reply email failed for ticket ${ticket.mask}: ${String(err)}`),
        );
    }

    // Notify watchers when a user (customer) replies
    if (!isStaffReply && this.notificationService) {
      this.notificationService
        .notifyWatchersOnUserReply(ticketId)
        .catch((err: unknown) =>
          this.logger.error(`Watcher notification failed for ticket ${ticket.mask}: ${String(err)}`),
        );
    }

    // Emit domain event
    this.emitDomainEvent('ticket.replied', ticketId);

    return post;
  }

  // ─────────────────────────── Note ───────────────────────────

  async addNote(ticketId: number, contents: string, staffId?: number): Promise<TicketNote> {
    await this.findOrThrow(ticketId);
    const note = await this.prisma.ticketNote.create({
      data: { ticketId, staffId, contents },
    });

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { hasNotes: true, lastActivityAt: new Date() },
    });

    await this.writeAudit(ticketId, 'NOTE', staffId, 'STAFF', {});
    return note;
  }

  // ─────────────────────────── Assign ───────────────────────────

  async assign(ticketId: number, dto: AssignTicketDto, staffId: number): Promise<Ticket> {
    const ticket = await this.findOrThrow(ticketId);

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { ownerStaffId: dto.ownerStaffId, lastActivityAt: new Date() },
    });

    await this.writeAudit(ticketId, 'ASSIGN', staffId, 'STAFF', {
      field: 'ownerStaffId',
      oldValue: ticket.ownerStaffId?.toString() ?? null,
      newValue: dto.ownerStaffId?.toString() ?? null,
    });

    // Notify the newly assigned staff member (non-blocking)
    if (dto.ownerStaffId && this.notificationService) {
      this.notificationService
        .notifyOnAssign(ticketId, dto.ownerStaffId)
        .catch((err: unknown) =>
          this.logger.error(`Assignment notification failed for ticket ${ticketId}: ${String(err)}`),
        );
    }

    return updated;
  }

  // ─────────────────────────── Status / Priority / Type ───────────────────────────

  async changeStatus(ticketId: number, dto: ChangeStatusDto, staffId: number): Promise<Ticket> {
    const ticket = await this.findOrThrow(ticketId);
    const status = await this.prisma.ticketStatus.findUnique({ where: { id: dto.statusId } });
    if (!status) throw new NotFoundException(`Status ${dto.statusId} not found`);

    const now = new Date();
    const wasResolved = ticket.isResolved;
    const becomesResolved = status.markAsResolved;
    const isReopen = wasResolved && !becomesResolved;

    let slaUpdate: {
      dueAt?: Date | null;
      resolutionDueAt?: Date | null;
      reopenedAt?: Date;
      wasReopened?: boolean;
    } = {};

    if (becomesResolved) {
      // Stop SLA timers on resolve
      slaUpdate = { dueAt: null, resolutionDueAt: null };
    }

    if (isReopen && ticket.slaPlanId) {
      // Reopen: recompute SLA due dates from now
      const dueDates = await this.slaService.computeDueDates(ticket.slaPlanId, now);
      slaUpdate = {
        dueAt: dueDates.dueAt,
        resolutionDueAt: dueDates.resolutionDueAt,
        reopenedAt: now,
        wasReopened: true,
      };
    }

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        statusId: dto.statusId,
        isResolved: becomesResolved,
        resolvedAt: becomesResolved ? now : null,
        lastActivityAt: now,
        ...slaUpdate,
      },
    });

    await this.writeAudit(ticketId, 'STATUS_CHANGE', staffId, 'STAFF', {
      field: 'statusId',
      oldValue: ticket.statusId.toString(),
      newValue: dto.statusId.toString(),
    });

    // Emit domain event
    this.emitDomainEvent('ticket.status_changed', ticketId);

    return updated;
  }

  async changePriority(ticketId: number, dto: ChangePriorityDto, staffId: number): Promise<Ticket> {
    const ticket = await this.findOrThrow(ticketId);

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { priorityId: dto.priorityId, lastActivityAt: new Date() },
    });

    await this.writeAudit(ticketId, 'PRIORITY_CHANGE', staffId, 'STAFF', {
      field: 'priorityId',
      oldValue: ticket.priorityId.toString(),
      newValue: dto.priorityId.toString(),
    });

    return updated;
  }

  async changeType(ticketId: number, dto: ChangeTypeDto, staffId: number): Promise<Ticket> {
    const ticket = await this.findOrThrow(ticketId);

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { typeId: dto.typeId, lastActivityAt: new Date() },
    });

    await this.writeAudit(ticketId, 'TYPE_CHANGE', staffId, 'STAFF', {
      field: 'typeId',
      oldValue: ticket.typeId?.toString() ?? null,
      newValue: dto.typeId?.toString() ?? null,
    });

    return updated;
  }

  // ─────────────────────────── Merge ───────────────────────────

  /**
   * Merge the source ticket into the target ticket.
   * All posts from source are re-parented to the target; source is marked merged.
   */
  async merge(sourceTicketId: number, dto: MergeTicketDto, staffId: number): Promise<Ticket> {
    const source = await this.findOrThrow(sourceTicketId);
    const target = await this.findOrThrow(dto.targetTicketId);

    if (source.id === target.id) {
      throw new BadRequestException('Cannot merge a ticket into itself');
    }
    if (source.mergedIntoId !== null) {
      throw new BadRequestException(`Ticket ${source.mask} is already merged`);
    }

    await this.prisma.$transaction(async (tx) => {
      const now = new Date();

      // Move all posts from source to target
      await tx.ticketPost.updateMany({
        where: { ticketId: sourceTicketId },
        data: { ticketId: target.id },
      });

      // Re-parent notes and attachments so they are not orphaned on the merged-away ticket
      await tx.ticketNote.updateMany({
        where: { ticketId: sourceTicketId },
        data: { ticketId: target.id },
      });
      await tx.attachment.updateMany({
        where: { ticketId: sourceTicketId },
        data: { ticketId: target.id },
      });

      // Re-parent watchers. The watcher PK is (ticketId, staffId), so a watcher
      // already present on the target would collide — move only the non-colliding
      // rows and drop the rest.
      const targetWatchers = await tx.ticketWatcher.findMany({
        where: { ticketId: target.id },
        select: { staffId: true },
      });
      const targetStaffIds = targetWatchers.map((w) => w.staffId);
      await tx.ticketWatcher.updateMany({
        where: { ticketId: sourceTicketId, staffId: { notIn: targetStaffIds } },
        data: { ticketId: target.id },
      });
      // Remaining source watchers are duplicates of target watchers — discard them.
      await tx.ticketWatcher.deleteMany({ where: { ticketId: sourceTicketId } });

      // Mark source as merged
      await tx.ticket.update({
        where: { id: sourceTicketId },
        data: { mergedIntoId: target.id, lastActivityAt: now },
      });

      // Bump target reply count
      await tx.ticket.update({
        where: { id: target.id },
        data: {
          totalReplies: { increment: source.totalReplies },
          lastActivityAt: now,
        },
      });
    });

    // Audit on both
    await this.writeAudit(sourceTicketId, 'MERGE', staffId, 'STAFF', {
      field: 'mergedIntoId',
      newValue: target.mask,
    });
    await this.writeAudit(target.id, 'MERGE_RECEIVED', staffId, 'STAFF', {
      field: 'mergedFrom',
      newValue: source.mask,
    });

    this.logger.log(`Ticket ${source.mask} merged into ${target.mask}`);
    return this.prisma.ticket.findUniqueOrThrow({ where: { id: target.id } });
  }

  // ─────────────────────────── Split ───────────────────────────

  /**
   * Split selected posts out of a ticket into a new ticket.
   * Creates a new ticket with the given subject and moves the selected posts to it.
   * Writes SPLIT audit entries on both tickets.
   */
  async split(sourceTicketId: number, dto: SplitTicketDto, staffId: number): Promise<Ticket> {
    const source = await this.findOrThrow(sourceTicketId);

    if (!dto.postIds.length) {
      throw new BadRequestException('postIds must not be empty');
    }

    // Verify all posts belong to the source ticket
    const posts = await this.prisma.ticketPost.findMany({
      where: { id: { in: dto.postIds }, ticketId: sourceTicketId },
    });

    if (posts.length !== dto.postIds.length) {
      throw new BadRequestException('Some postIds do not belong to this ticket');
    }

    // Resolve defaults for new ticket
    const statusId = await this.defaultStatusId();
    const priorityId = source.priorityId;
    const departmentId = dto.departmentId ?? source.departmentId;

    const now = new Date();

    // Compute SLA due dates for the new ticket
    let dueAt: Date | null = null;
    let resolutionDueAt: Date | null = null;
    if (source.slaPlanId) {
      const dueDates = await this.slaService.computeDueDates(source.slaPlanId, now);
      dueAt = dueDates.dueAt;
      resolutionDueAt = dueDates.resolutionDueAt;
    }

    // Create new ticket
    const newTicket = await this.prisma.ticket.create({
      data: {
        mask: 'TT-PENDING',
        subject: dto.subject,
        departmentId,
        statusId,
        priorityId,
        typeId: source.typeId,
        userId: source.userId,
        requesterName: source.requesterName,
        requesterEmail: source.requesterEmail,
        ownerStaffId: source.ownerStaffId,
        slaPlanId: source.slaPlanId,
        dueAt,
        resolutionDueAt,
        creationMode: source.creationMode,
        creator: 'STAFF',
        customFields: source.customFields as object,
        totalReplies: posts.length,
      },
    });

    const newMask = formatTicketMask(newTicket.id);

    await this.prisma.$transaction([
      // Update mask on new ticket
      this.prisma.ticket.update({
        where: { id: newTicket.id },
        data: { mask: newMask },
      }),
      // Move posts to new ticket
      this.prisma.ticketPost.updateMany({
        where: { id: { in: dto.postIds } },
        data: { ticketId: newTicket.id },
      }),
      // Decrement source reply count
      this.prisma.ticket.update({
        where: { id: sourceTicketId },
        data: {
          totalReplies: { decrement: posts.length },
          lastActivityAt: now,
        },
      }),
    ]);

    // Audit on both
    await this.writeAudit(sourceTicketId, 'SPLIT', staffId, 'STAFF', {
      field: 'splitTo',
      newValue: newMask,
    });
    await this.writeAudit(newTicket.id, 'SPLIT', staffId, 'STAFF', {
      field: 'splitFrom',
      newValue: source.mask,
    });

    this.logger.log(`Ticket ${source.mask} split into ${newMask} (${posts.length} posts)`);

    this.emitDomainEvent('ticket.created', newTicket.id);
    return this.prisma.ticket.findUniqueOrThrow({ where: { id: newTicket.id } });
  }

  // ─────────────────────────── Watchers ───────────────────────────

  async addWatcher(ticketId: number, dto: WatcherDto): Promise<void> {
    await this.findOrThrow(ticketId);
    await this.prisma.ticketWatcher.upsert({
      where: { ticketId_staffId: { ticketId, staffId: dto.staffId } },
      create: { ticketId, staffId: dto.staffId },
      update: {},
    });
  }

  async removeWatcher(ticketId: number, staffId: number): Promise<void> {
    await this.prisma.ticketWatcher.deleteMany({ where: { ticketId, staffId } });
  }

  // ─────────────────────────── Tags ───────────────────────────

  async addTag(ticketId: number, dto: TagDto): Promise<void> {
    await this.findOrThrow(ticketId);
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        tags: {
          connectOrCreate: {
            where: { name: dto.name },
            create: { name: dto.name },
          },
        },
      },
    });
  }

  async removeTag(ticketId: number, tagName: string): Promise<void> {
    await this.findOrThrow(ticketId);
    const tag = await this.prisma.ticketTag.findUnique({ where: { name: tagName } });
    if (!tag) return; // idempotent
    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { tags: { disconnect: { name: tagName } } },
    });
  }

  // ─────────────────────────── Apply Macro ───────────────────────────

  /**
   * Apply a macro to a ticket.
   * If the macro has reply text, it is posted as a staff reply.
   * Each action in actions[] is executed (set_status / set_priority / assign / add_tag /
   * change_status / change_priority / change_owner / add_tag — tolerates both naming schemes).
   */
  async applyMacro(ticketId: number, dto: ApplyMacroDto, staffId: number): Promise<Ticket> {
    const ticket = await this.findOrThrow(ticketId);

    const macro = await this.prisma.macro.findUnique({ where: { id: dto.macroId } });
    if (!macro) throw new NotFoundException(`Macro ${dto.macroId} not found`);

    // 1. Post the reply text if present
    if (macro.replyText && macro.replyText.trim()) {
      const staff = await this.prisma.staff.findUnique({ where: { id: staffId } });
      const now = new Date();

      await this.prisma.ticketPost.create({
        data: {
          ticketId,
          authorType: 'STAFF',
          staffId,
          fullName: staff ? `${staff.firstName} ${staff.lastName}`.trim() || staff.email : undefined,
          email: staff?.email,
          subject: ticket.subject,
          contents: macro.replyText,
          isHtml: false,
          creationMode: 'STAFF',
          ipAddress: '0.0.0.0',
        },
      });

      await this.prisma.ticket.update({
        where: { id: ticketId },
        data: {
          totalReplies: { increment: 1 },
          lastReplyAt: now,
          lastActivityAt: now,
          ...(ticket.firstResponseAt === null ? { firstResponseAt: now } : {}),
        },
      });
    }

    // 2. Execute actions[]
    const actions = macro.actions as unknown as Array<Record<string, unknown>>;
    if (Array.isArray(actions) && actions.length > 0) {
      const ticketUpdate: Partial<Record<string, unknown>> = {};

      for (const action of actions) {
        const type = action['type'] as string | undefined;
        try {
          switch (type) {
            case 'set_status':
            case 'change_status':
              if (action['statusId']) ticketUpdate['statusId'] = action['statusId'];
              break;
            case 'set_priority':
            case 'change_priority':
              if (action['priorityId']) ticketUpdate['priorityId'] = action['priorityId'];
              break;
            case 'assign':
            case 'change_owner':
              ticketUpdate['ownerStaffId'] = action['ownerStaffId'] ?? null;
              break;
            case 'change_department':
              if (action['departmentId']) ticketUpdate['departmentId'] = action['departmentId'];
              break;
            case 'add_tag':
              if (typeof action['tag'] === 'string' && action['tag']) {
                await this.prisma.ticket.update({
                  where: { id: ticketId },
                  data: {
                    tags: {
                      connectOrCreate: {
                        where: { name: action['tag'] as string },
                        create: { name: action['tag'] as string },
                      },
                    },
                  },
                });
              }
              break;
            case 'add_note':
              if (typeof action['note'] === 'string' && action['note']) {
                await this.prisma.ticketNote.create({
                  data: {
                    ticketId,
                    staffId,
                    contents: `[Macro: ${macro.title}] ${action['note']}`,
                  },
                });
              }
              break;
          }
        } catch (err) {
          this.logger.error(
            `Macro ${macro.id} action ${type ?? 'unknown'} failed on ticket ${ticket.mask}: ${String(err)}`,
          );
        }
      }

      // A status change must go through changeStatus() so isResolved/resolvedAt and
      // SLA timers are updated correctly (a raw update would leave them stale).
      if (ticketUpdate['statusId']) {
        await this.changeStatus(ticketId, { statusId: ticketUpdate['statusId'] as number }, staffId);
        delete ticketUpdate['statusId'];
      }

      if (Object.keys(ticketUpdate).length > 0) {
        ticketUpdate['lastActivityAt'] = new Date();
        await this.prisma.ticket.update({ where: { id: ticketId }, data: ticketUpdate });
      }
    }

    await this.writeAudit(ticketId, 'MACRO_APPLIED', staffId, 'STAFF', {
      field: 'macroId',
      newValue: String(macro.id),
    });

    this.logger.log(`Macro ${macro.id} applied to ticket ${ticket.mask} by staff ${staffId}`);
    return this.prisma.ticket.findUniqueOrThrow({ where: { id: ticketId } });
  }

  // ─────────────────────────── Change Department ───────────────────────────

  /**
   * Change the department a ticket belongs to.
   */
  async changeDepartment(ticketId: number, dto: ChangeDepartmentDto, staffId: number): Promise<Ticket> {
    const ticket = await this.findOrThrow(ticketId);

    const dept = await this.prisma.department.findUnique({ where: { id: dto.departmentId } });
    if (!dept) throw new NotFoundException(`Department ${dto.departmentId} not found`);

    const updated = await this.prisma.ticket.update({
      where: { id: ticketId },
      data: { departmentId: dto.departmentId, lastActivityAt: new Date() },
    });

    await this.writeAudit(ticketId, 'DEPARTMENT_CHANGE', staffId, 'STAFF', {
      field: 'departmentId',
      oldValue: ticket.departmentId.toString(),
      newValue: dto.departmentId.toString(),
    });

    return updated;
  }

  // ─────────────────────────── Domain events ───────────────────────────

  /**
   * Emit a domain event via EventEmitter2 for SLA/workflow processing.
   */
  protected emitDomainEvent(event: string, ticketId: number): void {
    this.eventEmitter.emit(event, { ticketId });
  }

  // ─────────────────────────── Helpers ───────────────────────────

  private async findOrThrow(id: number): Promise<Ticket> {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`Ticket ${id} not found`);
    return t;
  }

  private async defaultStatusId(): Promise<number> {
    const s = await this.prisma.ticketStatus.findFirst({ where: { isDefault: true } });
    if (!s) throw new BadRequestException('No default ticket status configured');
    return s.id;
  }

  private async defaultPriorityId(): Promise<number> {
    // No isDefault flag on TicketPriority — return the priority with the lowest displayOrder
    const p = await this.prisma.ticketPriority.findFirst({ orderBy: { displayOrder: 'asc' } });
    if (!p) throw new BadRequestException('No ticket priorities configured');
    return p.id;
  }

  private async writeAudit(
    ticketId: number,
    action: string,
    staffId: number | undefined,
    actorType: ActorType,
    opts: { field?: string; oldValue?: string | null; newValue?: string | null },
  ): Promise<void> {
    await this.prisma.ticketAuditLog.create({
      data: {
        ticketId,
        staffId: staffId ?? null,
        actorType,
        action,
        field: opts.field ?? null,
        oldValue: opts.oldValue ?? null,
        newValue: opts.newValue ?? null,
      },
    });
  }
}
