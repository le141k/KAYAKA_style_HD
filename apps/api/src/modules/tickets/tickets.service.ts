import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { SlaService } from '../sla/sla.service';
import { MailService } from '../mail/mail.service';
import { AdminService } from '../admin/admin.service';
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
} from './dto';
import type { ActorType, CreationMode, Ticket, TicketPost, TicketNote } from '@prisma/client';

/** Rich ticket view returned by getTicket. */
export interface TicketDetail extends Ticket {
  posts: TicketPost[];
  notes: TicketNote[];
  watchers: Array<{ staffId: number }>;
  tags: Array<{ name: string }>;
}

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

    // Create ticket without mask first (need id for mask)
    const ticket = await this.prisma.ticket.create({
      data: {
        mask: 'TT-PENDING', // temporary; updated immediately below
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

    // Update mask now that we have the real ID
    const mask = formatTicketMask(ticket.id);
    const updated = await this.prisma.ticket.update({
      where: { id: ticket.id },
      data: { mask },
    });

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
          user: { include: { emails: true } },
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
        user: { include: { emails: true } },
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
        user: { include: { emails: true } },
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

    await this.prisma.ticket.update({
      where: { id: ticketId },
      data: {
        totalReplies: { increment: 1 },
        lastReplyAt: now,
        lastActivityAt: now,
        // Mark first staff response time if not yet set
        ...(firstResponse && { firstResponseAt: now }),
      },
    });

    await this.writeAudit(ticketId, 'REPLY', staffId ?? undefined, isStaffReply ? 'STAFF' : 'USER', {});

    // Send outbound email to requester when a staff member replies (non-blocking)
    if (isStaffReply && ticket.requesterEmail) {
      const requesterName = ticket.requesterName || ticket.requesterEmail;
      this.mailService
        .sendTemplate(ticket.requesterEmail, 'ticket_user_reply', 'en', {
          mask: ticket.mask,
          subject: ticket.subject,
          contents: dto.contents,
          // Templates reference {{name}}; keep requesterName too for forward-compat.
          name: requesterName,
          requesterName,
        })
        .catch((err: unknown) =>
          this.logger.error(`Reply email failed for ticket ${ticket.mask}: ${String(err)}`),
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

    await this.prisma.$transaction([
      // Move all posts from source to target
      this.prisma.ticketPost.updateMany({
        where: { ticketId: sourceTicketId },
        data: { ticketId: target.id },
      }),
      // Mark source as merged
      this.prisma.ticket.update({
        where: { id: sourceTicketId },
        data: { mergedIntoId: target.id, lastActivityAt: new Date() },
      }),
      // Bump target reply count
      this.prisma.ticket.update({
        where: { id: target.id },
        data: {
          totalReplies: { increment: source.totalReplies },
          lastActivityAt: new Date(),
        },
      }),
    ]);

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
