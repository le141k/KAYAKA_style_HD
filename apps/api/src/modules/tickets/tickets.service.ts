import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { SlaService } from '../sla/sla.service';
import { MailService } from '../mail/mail.service';
import { AdminService } from '../admin/admin.service';
import { AttachmentsService } from '../attachments/attachments.service';
import { NotificationService } from './notification.service';
import { formatTicketMask } from './ticket-mask.util';
import { normalizeEmail } from '../../common/email.util';
import { TicketAccessPolicy, type TicketAccessActor } from './ticket-access-policy.service';
import type {
  CreateTicketDto,
  ReplyTicketDto,
  AssignTicketDto,
  BulkTicketActionDto,
  ChangeStatusDto,
  ChangePriorityDto,
  ChangeTypeDto,
  MergeTicketDto,
  SplitTicketDto,
  ListTicketsQueryDto,
  TagDto,
  WatcherDto,
  LinkTicketDto,
  SpawnSupplierDto,
  PublicReplyDto,
  ApplyMacroDto,
  ChangeDepartmentDto,
} from './dto';
import { Prisma } from '@prisma/client';
import type { ActorType, CreationMode, Ticket, TicketPost, TicketNote } from '@prisma/client';

/** Rich ticket view returned by getTicket. */
export interface TicketDetail extends Ticket {
  posts: TicketPost[];
  notes: TicketNote[];
  watchers: Array<{ staffId: number }>;
  tags: Array<{ name: string }>;
}

/**
 * Client-safe ticket fields for the @Public "my tickets" list. Deliberately
 * omits infra/PII columns (ipAddress, customFields, messageId, creationMode,
 * slaPlanId, internal SLA timestamps) — those must never reach an unauthenticated
 * caller who only supplies an email address.
 */
export const PUBLIC_TICKET_LIST_SELECT = {
  id: true,
  mask: true,
  subject: true,
  requesterName: true,
  requesterEmail: true,
  statusId: true,
  priorityId: true,
  typeId: true,
  departmentId: true,
  dueAt: true,
  totalReplies: true,
  isResolved: true,
  lastActivityAt: true,
  createdAt: true,
  updatedAt: true,
  status: { select: { id: true, title: true } },
  priority: { select: { id: true, title: true } },
  type: { select: { id: true, title: true } },
  department: { select: { id: true, title: true } },
} satisfies Prisma.TicketSelect;

export type PublicTicketListItem = Prisma.TicketGetPayload<{ select: typeof PUBLIC_TICKET_LIST_SELECT }>;

/**
 * Trusted service-to-service create input. `incomingMessageId` is deliberately
 * absent from CreateTicketSchema, so an HTTP caller cannot choose the RFC
 * Message-ID used for inbound-mail idempotency.
 */
export type InternalCreateTicketInput = CreateTicketDto & {
  attachmentClaimToken?: string;
  creationMode?: CreationMode;
  ipAddress?: string;
  incomingMessageId?: string;
};

/** Trusted service-to-service reply input; not accepted by ReplyTicketSchema. */
export type InternalReplyTicketInput = ReplyTicketDto & {
  creationMode?: CreationMode;
  ipAddress?: string;
  incomingMessageId?: string;
};

interface StaffReplyOutboxDraft {
  messageId: string;
  emailQueueId: number | null;
  fromAddress: string;
  replyToAddress: string | null;
  subject: string;
  htmlBody: string;
  textBody: string;
  inReplyTo: string | null;
  references: string[];
  recipients: Array<{ email: string; role: 'TO' | 'CC' | 'BCC' }>;
}

/**
 * A client-safe post. Internal/PII fields (staff `email`, `ipAddress`, `staffId`,
 * `messageId`, edit audit) are NEVER projected onto the public ticket view.
 */
export interface PublicTicketPost {
  id: number;
  ticketId: number;
  authorType: ActorType;
  userId: number | null;
  fullName: string;
  contents: string;
  isHtml: boolean;
  createdAt: Date;
  attachments: { id: number; fileName: string; size: number; mimeType: string }[];
}

/** Public ticket view — posts only, no notes. */
export interface PublicTicketDetail extends Ticket {
  posts: PublicTicketPost[];
  status: { id: number; title: string } | null;
  priority: { id: number; title: string } | null;
  department: { id: number; title: string } | null;
  owner: { id: number; firstName: string; lastName: string } | null;
  user: { id: number; fullName: string; emails: { email: string; isPrimary: boolean }[] } | null;
  tags: Array<{ name: string }>;
}

/** Non-sensitive user fields exposed on public ticket views (never passwordHash). */
const PUBLIC_USER_SELECT = {
  id: true,
  fullName: true,
  emails: { select: { email: true, isPrimary: true } },
} as const;

// These values deliberately stay below the RFC 5322 physical-line limit after
// the transport adds the header name.  Historic TicketPost rows predate the
// inbound validator, so never trust their Message-ID values as SMTP headers.
const MAX_OUTBOUND_THREADING_MESSAGE_ID_CHARS = 512;
const MAX_OUTBOUND_REFERENCES_CHARS = 900;

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
    @Optional() private readonly ticketAccess?: TicketAccessPolicy,
  ) {}

  // ─────────────────────────── Create ───────────────────────────

  /** Resolve only a PUBLIC department for anonymous ticket creation. */
  async resolvePublicDepartmentId(requestedId?: number): Promise<number> {
    const department = await this.prisma.department.findFirst({
      where: {
        type: 'PUBLIC',
        ...(requestedId ? { id: requestedId } : {}),
      },
      ...(!requestedId
        ? {
            orderBy: [
              { isDefault: 'desc' as const },
              { displayOrder: 'asc' as const },
              { id: 'asc' as const },
            ],
          }
        : {}),
      select: { id: true },
    });
    if (!department) {
      // Identical response for a missing/private guessed id; never disclose the
      // internal department inventory to an anonymous caller.
      throw new BadRequestException('Public department is unavailable');
    }
    return department.id;
  }

  async createTicket(
    // creationMode/ipAddress are not on the public DTO (mass-assignment guard) — only
    // trusted callers (controllers, alaris/inbound services) set them here.
    dto: InternalCreateTicketInput,
    creatorStaffId?: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    if (actor) {
      const ticketAccess = this.requireTicketAccess(actor);
      await ticketAccess.assertCanAccessDepartment(actor, dto.departmentId);
      if (dto.ownerStaffId != null) {
        await ticketAccess.assertAssigneeCanHandleDepartments(dto.ownerStaffId, [dto.departmentId]);
      }
    }
    const incomingMessageId = this.normalizeIncomingMessageId(dto.incomingMessageId);
    if (incomingMessageId) {
      const existing = await this.findTicketByInboundMessageId(incomingMessageId);
      if (existing) {
        // A staff-facing call must not use an idempotency key as an alternate
        // ticket lookup. HTTP DTOs cannot set this field, but enforcing the
        // invariant here protects future internal callers too.
        if (actor) await this.requireTicketAccess(actor).assertCanAccessTicket(actor, existing.id);
        return existing;
      }
    }

    const creationMode: CreationMode = dto.creationMode ?? 'STAFF';
    const ipAddress = dto.ipAddress ?? '0.0.0.0';
    // Validate custom fields against TICKET scope definitions, then encrypt any
    // fields flagged isEncrypted before they are persisted to the JSONB column.
    let customFields = dto.customFields as Record<string, unknown> | undefined;
    if (customFields && typeof customFields === 'object') {
      await this.adminService.validateCustomFields('TICKET', customFields);
      customFields = await this.adminService.encryptCustomFields('TICKET', customFields);
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

    if (dto.attachmentIds?.length && !this.attachmentsService) {
      throw new BadRequestException('Attachment service is unavailable');
    }

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
    let updated: Ticket;
    try {
      const [, transactionTicket] = await this.prisma.$transaction(async (tx) => {
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
            creationMode,
            creator: creatorActor,
            ipAddress,
            customFields: (customFields ?? {}) as object,
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
                creationMode,
                messageId: incomingMessageId,
                inboundMessageId: incomingMessageId,
                ipAddress,
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
          include: { posts: { select: { id: true } } },
        });

        if (dto.attachmentIds?.length && this.attachmentsService) {
          const firstPost = created.posts[0];
          if (!firstPost) throw new BadRequestException('Initial ticket post was not created');
          await this.attachmentsService.linkToPost(
            dto.attachmentIds,
            firstPost.id,
            created.id,
            dto.attachmentClaimToken,
            tx,
          );
        }

        const updatedTicket = await tx.ticket.update({
          where: { id: created.id },
          data: {
            mask: formatTicketMask(created.id),
            ...(dto.attachmentIds?.length ? { hasAttachments: true } : {}),
          },
        });

        // LIFE-03: persist CC/BCC recipients AND the CREATE audit inside the SAME
        // transaction as the ticket + first post + attachment links. Writing them
        // after commit left a crash window in which a ticket could exist with no
        // recipients / no audit row — and the P2002 retry path returns the existing
        // ticket, so a follow-up delivery would never re-create them. Atomic now.
        const allRecipients = [
          ...(dto.ccEmails ?? []).map((email) => ({ email, role: 'CC' as const })),
          ...(dto.bccEmails ?? []).map((email) => ({ email, role: 'BCC' as const })),
        ];
        if (allRecipients.length > 0) {
          await tx.ticketRecipient.createMany({
            data: allRecipients.map((r) => ({ ticketId: created.id, email: r.email, role: r.role })),
            skipDuplicates: true,
          });
        }
        await this.writeAudit(
          created.id,
          'CREATE',
          creatorStaffId,
          creatorActor,
          { newValue: updatedTicket.mask },
          tx,
        );

        return [created, updatedTicket] as const;
      });
      updated = transactionTicket;
    } catch (err) {
      // Concurrent delivery: the inbound-only unique index is the final arbiter. The
      // losing transaction is fully rolled back; return the winning ticket and
      // skip recipients, audit, events and autoresponder.
      if (incomingMessageId && this.isUniqueConstraintViolation(err)) {
        const existing = await this.findTicketByInboundMessageId(incomingMessageId);
        if (existing) return existing;
      }
      throw err;
    }

    const mask = updated.mask;

    // Recipients + CREATE audit are now written INSIDE the create transaction above
    // (LIFE-03), so a crash after commit can never leave them missing.
    this.logger.log(`Ticket ${mask} created`);

    // Emit domain event
    this.emitDomainEvent('ticket.created', updated.id);

    // Send autoresponder email to requester (non-blocking).
    // Skip for system-generated tickets (e.g. Alaris) — their requesterEmail is a
    // non-deliverable internal address and should not receive an autoresponder.
    const isSystemTicket = creationMode === 'ALARIS';
    // Per-queue autoresponder (Kayako): for inbound EMAIL tickets, only send the
    // autoresponder when the receiving queue opts in (noc@/rates@ are OFF). Web/
    // staff/API tickets keep the previous always-send behaviour.
    let suppressAutoresponder = false;
    if (creationMode === 'EMAIL') {
      const queue = await this.prisma.emailQueue.findFirst({
        where: { departmentId: dto.departmentId },
        select: { sendAutoresponder: true },
      });
      suppressAutoresponder = !queue?.sendAutoresponder;
    }
    if (dto.requesterEmail && !isSystemTicket && !suppressAutoresponder) {
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
  async listMyTickets(clientUserId: number): Promise<{ data: PublicTicketListItem[]; total: number }> {
    // Authorize strictly by stable ownership — the verified session's userId (S2-7).
    const where = { mergedIntoId: null, userId: clientUserId };

    const [data, total] = await Promise.all([
      this.prisma.ticket.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        // Narrow select — this is a @Public endpoint, so NEVER leak infra/PII
        // columns (ipAddress, customFields, messageId, creationMode) to anyone
        // who supplies an email address.
        select: PUBLIC_TICKET_LIST_SELECT,
        // Bound the result so a heavy requester (or abuse) can't pull an unbounded
        // set on this public endpoint; `total` still reflects the true count.
        take: 200,
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
  async getPublicTicket(id: number, clientUserId: number): Promise<PublicTicketDetail> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id },
      include: {
        status: { select: { id: true, title: true } },
        priority: { select: { id: true, title: true } },
        department: { select: { id: true, title: true } },
        // Client-facing: expose the agent's display name only — NOT their email (PII).
        owner: { select: { id: true, firstName: true, lastName: true } },
        // Narrow select — NEVER expose passwordHash or other sensitive user fields
        user: { select: PUBLIC_USER_SELECT },
        // Only posts (USER/STAFF replies) — notes are intentionally excluded.
        // Narrow select: NEVER expose staff email/ipAddress or internal audit fields.
        // Third-party posts (staff↔supplier correspondence) must stay hidden from the
        // client (GOAL_PUBLIC_SECURITY S2-10).
        posts: {
          // Third-party/vendor correspondence (isThirdParty) is internal-facing in
          // the Kayako model (hidden from the customer by default) — never expose it
          // on the public ticket view (S2-10).
          where: { isThirdParty: false },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            ticketId: true,
            authorType: true,
            userId: true,
            fullName: true,
            contents: true,
            isHtml: true,
            createdAt: true,
            attachments: { select: { id: true, fileName: true, size: true, mimeType: true } },
          },
        },
        tags: { select: { name: true } },
      },
    });

    if (!ticket) throw new NotFoundException(`Ticket ${id} not found`);

    // Ownership check: authorize only when the ticket belongs to the verified client.
    this.assertClientOwnsTicket(ticket, clientUserId);

    // Redact infra/PII + internal columns before returning to the @Public caller.
    // (findUnique with top-level `include` returns ALL ticket scalars.) Keep only
    // client-relevant fields (subject, mask, status/priority/department, dueAt,
    // timestamps, requester); strip internal routing/SLA/audit fields.
    const safe = { ...ticket } as Record<string, unknown>;
    for (const k of [
      'ipAddress',
      'customFields',
      'messageId',
      'creationMode',
      'creator',
      'flagType',
      'hasNotes',
      'ownerStaffId',
      'slaPlanId',
      'resolutionDueAt',
      'firstResponseAt',
      'resolvedAt',
      'reopenedAt',
      'wasReopened',
      'isEscalated',
      'escalationLevel',
      'kayakoId',
      'mergedIntoId',
    ]) {
      delete safe[k];
    }
    return safe as unknown as PublicTicketDetail;
  }

  /**
   * Authorize a verified client for a ticket by STABLE ownership (S2-7):
   * `Ticket.userId` must equal the session's `userId`. Throws NotFoundException (not
   * Forbidden) so wrong-owner, unmapped (null userId) and missing tickets are all
   * indistinguishable — no enumeration and no "email as password".
   */
  private assertClientOwnsTicket(ticket: { id: number; userId: number | null }, clientUserId: number): void {
    if (ticket.userId === null || ticket.userId !== clientUserId) {
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
  async publicReply(ticketId: number, dto: PublicReplyDto, clientUserId: number): Promise<TicketPost> {
    const ticket = await this.prisma.ticket.findUnique({
      where: { id: ticketId },
      include: {
        status: { select: { markAsResolved: true, title: true } },
      },
    });
    if (!ticket) throw new NotFoundException(`Ticket ${ticketId} not found`);

    // Ownership check: only the verified owner of this ticket may reply (S2-7).
    this.assertClientOwnsTicket(ticket, clientUserId);

    // U-medium: block public replies on definitively-closed tickets.
    // Strategy: a ticket is "closed" (not merely "resolved") when its status is
    // flagged markAsResolved=true AND the title contains "closed" (case-insensitive).
    // This matches the standard Kayako data model where "Resolved" reopens on reply
    // but "Closed" is terminal.  If no "closed" status exists in the database
    // (single-status setups), only the markAsResolved flag is checked and a
    // second heuristic is applied: reopenedAt IS NULL + isResolved = true means
    // the ticket was resolved first-time — still allowed to be re-opened by a
    // customer reply.  A ticket that has been closed after having been reopened
    // (wasReopened=true, isResolved=true, no reopenedAt) is also blocked.
    // Simplest correct rule that survives schema variations:
    //   BLOCK only when the current status title is exactly "Closed" (case-insensitive)
    //   AND markAsResolved is true.
    // For all other resolved statuses the existing reopen path continues to apply.
    const statusTitle = ticket.status as { markAsResolved: boolean; title: string } | null;
    if (statusTitle && statusTitle.markAsResolved && statusTitle.title.trim().toLowerCase() === 'closed') {
      throw new BadRequestException('Ticket is closed and cannot receive new replies');
    }

    // H8-3: a public adoption MUST carry a claimToken; otherwise linkToPost would
    // fall back to adopting any orphan by id (IDOR). Reject rather than silently
    // adopt without the per-upload secret.
    if (dto.attachmentIds?.length && !dto.attachmentClaimToken) {
      throw new BadRequestException('attachmentClaimToken is required when attachmentIds are provided');
    }
    if (dto.attachmentIds?.length && !this.attachmentsService) {
      throw new BadRequestException('Attachment service is unavailable');
    }

    const now = new Date();
    const hasPublicAttachments = Boolean(dto.attachmentIds?.length);

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

    const post = await this.prisma.$transaction(async (tx) => {
      const createdPost = await tx.ticketPost.create({
        data: {
          ticketId,
          authorType: 'USER',
          staffId: null,
          userId: ticket.userId,
          fullName: ticket.requesterName ?? undefined,
          // Identity is taken from the ticket/session, never from the request body.
          email: ticket.requesterEmail ?? undefined,
          subject: ticket.subject,
          contents: dto.contents,
          isHtml: false,
          creationMode: 'WEB',
          ipAddress: '0.0.0.0',
        },
      });
      if (hasPublicAttachments && this.attachmentsService) {
        await this.attachmentsService.linkToPost(
          dto.attachmentIds!,
          createdPost.id,
          ticketId,
          dto.attachmentClaimToken,
          tx,
        );
      }
      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          totalReplies: { increment: 1 },
          lastReplyAt: now,
          lastActivityAt: now,
          ...(hasPublicAttachments && { hasAttachments: true }),
          ...reopenData,
        },
      });
      return createdPost;
    });

    await this.writeAudit(ticketId, 'REPLY', undefined, 'USER', {});
    this.emitDomainEvent('ticket.replied', ticketId);

    return post;
  }

  // ─────────────────────────── List ───────────────────────────

  async listTickets(
    query: ListTicketsQueryDto,
    actor?: TicketAccessActor,
  ): Promise<{ data: Ticket[]; total: number }> {
    const { page, limit, sortBy, sortDir, unassigned, search, sla_breached, ...filters } = query;

    // Keep the caller's filters and department policy as separate AND terms.
    // Assigning `departmentId` directly onto an existing scope object would let a
    // query parameter replace `{ in: allowedDepartments }` with an arbitrary id.
    const requestedWhere: Record<string, unknown> = {};

    if (filters.statusId !== undefined) requestedWhere['statusId'] = filters.statusId;
    if (filters.priorityId !== undefined) requestedWhere['priorityId'] = filters.priorityId;
    if (filters.departmentId !== undefined) requestedWhere['departmentId'] = filters.departmentId;
    if (filters.typeId !== undefined) requestedWhere['typeId'] = filters.typeId;
    if (filters.userId !== undefined) requestedWhere['userId'] = filters.userId;
    if (filters.isResolved !== undefined) requestedWhere['isResolved'] = filters.isResolved;

    if (filters.ownerStaffId !== undefined) requestedWhere['ownerStaffId'] = filters.ownerStaffId;
    if (unassigned) requestedWhere['ownerStaffId'] = null;

    // SLA breach is computed server-side: unresolved tickets whose dueAt is in the
    // past. (Previously filtered client-side, which broke counts across pages.)
    if (sla_breached) {
      requestedWhere['isResolved'] = false;
      requestedWhere['dueAt'] = { lt: new Date() };
    }

    if (filters.createdAfter || filters.createdBefore) {
      requestedWhere['createdAt'] = {
        ...(filters.createdAfter ? { gte: filters.createdAfter } : {}),
        ...(filters.createdBefore ? { lte: filters.createdBefore } : {}),
      };
    }

    if (search) {
      requestedWhere['OR'] = [
        { subject: { contains: search, mode: 'insensitive' } },
        { mask: { contains: search } },
        { requesterEmail: { contains: search, mode: 'insensitive' } },
        { requesterName: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Exclude merged-away tickets from the main list
    requestedWhere['mergedIntoId'] = null;

    const where: Prisma.TicketWhereInput = actor
      ? {
          AND: [
            await this.requireTicketAccess(actor).ticketWhere(actor),
            requestedWhere as Prisma.TicketWhereInput,
          ],
        }
      : (requestedWhere as Prisma.TicketWhereInput);

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
          // Staff list shows the requester's organization on the right — include it.
          user: { select: { ...PUBLIC_USER_SELECT, organization: { select: { id: true, name: true } } } },
          tags: { select: { name: true } },
        },
      }),
      this.prisma.ticket.count({ where }),
    ]);

    // D9: decrypt encrypted customFields so ciphertext never reaches the staff UI.
    await this.adminService.decryptCustomFieldsMany('TICKET', data);
    return { data, total };
  }

  // ─────────────────────────── Get ───────────────────────────

  async getTicket(id: number, actor?: TicketAccessActor): Promise<TicketDetail> {
    const query = {
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
            // Safe staff-only delivery projection: recipients (especially BCC),
            // raw bodies and relay response details remain out of the ticket API.
            outboundEmail: {
              select: {
                id: true,
                state: true,
                attempts: true,
                nextAttemptAt: true,
                lastError: true,
                acceptedAt: true,
                sentAt: true,
              },
            },
          },
        },
        notes: {
          orderBy: { createdAt: 'asc' },
          include: {
            staff: { select: { firstName: true, lastName: true, email: true } },
            attachments: true, // U1: include note attachments in the ticket detail view
          },
        },
        attachments: true,
        watchers: { select: { staffId: true } },
        tags: { select: { name: true } },
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 50 },
        recipients: { orderBy: { addedAt: 'asc' } },
      },
    } as const;
    const ticket = actor
      ? await this.prisma.ticket.findFirst({
          ...query,
          where: { AND: [{ id }, await this.requireTicketAccess(actor).ticketWhere(actor)] },
        })
      : await this.prisma.ticket.findUnique({ ...query, where: { id } });

    if (!ticket) throw new NotFoundException(`Ticket ${id} not found`);
    ticket.customFields = (await this.adminService.decryptCustomFields(
      'TICKET',
      ticket.customFields as Record<string, unknown>,
    )) as object;
    return ticket as unknown as TicketDetail;
  }

  async getTicketByMask(mask: string, actor?: TicketAccessActor): Promise<TicketDetail> {
    const query = {
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
            outboundEmail: {
              select: {
                id: true,
                state: true,
                attempts: true,
                nextAttemptAt: true,
                lastError: true,
                acceptedAt: true,
                sentAt: true,
              },
            },
          },
        },
        notes: { orderBy: { createdAt: 'asc' } },
        attachments: true,
        watchers: { select: { staffId: true } },
        tags: { select: { name: true } },
        auditLogs: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    } as const;
    const ticket = actor
      ? await this.prisma.ticket.findFirst({
          ...query,
          where: { AND: [{ mask }, await this.requireTicketAccess(actor).ticketWhere(actor)] },
        })
      : await this.prisma.ticket.findUnique({ ...query, where: { mask } });

    if (!ticket) throw new NotFoundException(`Ticket ${mask} not found`);
    ticket.customFields = (await this.adminService.decryptCustomFields(
      'TICKET',
      ticket.customFields as Record<string, unknown>,
    )) as object;
    return ticket as unknown as TicketDetail;
  }

  // ─────────────────────────── Reply ───────────────────────────

  async reply(
    ticketId: number,
    // creationMode/ipAddress are not on the public DTO (mass-assignment guard) — the
    // controller forces STAFF + real ip; inbound mail passes EMAIL explicitly.
    dto: InternalReplyTicketInput,
    staffId?: number,
    actor?: TicketAccessActor,
  ): Promise<TicketPost | TicketNote> {
    const incomingMessageId = this.normalizeIncomingMessageId(dto.incomingMessageId);
    if (dto.isNote) {
      if (incomingMessageId) {
        throw new BadRequestException('Inbound Message-ID cannot be assigned to an internal note');
      }
      return actor
        ? this.addNote(ticketId, dto.contents, staffId, dto.attachmentIds, actor)
        : this.addNote(ticketId, dto.contents, staffId, dto.attachmentIds);
    }

    // Fast-path ordinary redelivery before doing any ticket/author work. The
    // inbound-only unique index remains the concurrency-safe arbiter below; do
    // not let a spoofed staff outbound threading Message-ID suppress this mail.
    // Staff-facing calls authorize their requested ticket before looking at a
    // duplicate key. This prevents a future caller from turning a known
    // Message-ID into an alternate read path for another department.
    const actorTicket = actor ? await this.findAccessibleOrThrow(ticketId, actor) : undefined;

    // Fast-path ordinary redelivery before doing any ticket/author work. The
    // inbound-only unique index remains the concurrency-safe arbiter below; do
    // not let a spoofed staff outbound threading Message-ID suppress this mail.
    if (incomingMessageId) {
      const existing = await this.findPostByInboundMessageId(incomingMessageId);
      if (existing) {
        if (actor && existing.ticketId !== ticketId)
          throw new NotFoundException(`Ticket ${ticketId} not found`);
        return existing;
      }
    }

    const ticket = actorTicket ?? (await this.findAccessibleOrThrow(ticketId));

    if (dto.attachmentIds?.length && !this.attachmentsService) {
      throw new BadRequestException('Attachment service is unavailable');
    }

    const replyCreationMode: CreationMode = dto.creationMode ?? 'STAFF';
    const replyIp = dto.ipAddress ?? '0.0.0.0';
    const now = new Date();
    const isStaffReply = !!staffId;

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

    const hasNewAttachments = Boolean(dto.attachmentIds?.length);

    // A public staff reply without a recipient is neither a delivery nor an
    // internal note. Refuse it rather than creating a timeline entry the UI could
    // mistake for queued/sent email; the operator can add a note until requester
    // identity is repaired.
    if (isStaffReply && !incomingMessageId && !ticket.requesterEmail.trim()) {
      throw new BadRequestException(
        'Ticket has no requester email; add an internal note or repair the requester first',
      );
    }

    // Staff public replies use a database-backed SMTP command. Build all immutable
    // snapshots before opening the transaction; the transaction below persists the
    // post, counters, audit, recipients and attachment snapshots as one unit. An
    // inbound trusted Message-ID is never repurposed as an outbound command.
    const outboundDraft =
      isStaffReply && ticket.requesterEmail && !incomingMessageId
        ? await this.prepareStaffReplyOutboxDraft(ticket, dto, staffId!, authorName, authorEmail)
        : undefined;

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

    let post: TicketPost;
    let outboundEmailId: string | undefined;
    try {
      const committed = await this.prisma.$transaction(async (tx) => {
        const createdPost = await tx.ticketPost.create({
          data: {
            ticketId,
            authorType: isStaffReply ? 'STAFF' : 'USER',
            staffId,
            fullName: authorName,
            email: authorEmail,
            subject: ticket.subject,
            contents: dto.contents,
            isHtml: dto.isHtml,
            // A staff post becomes emailed only after the SMTP worker commits
            // SENT. The HTTP DTO may not manufacture delivery truth.
            isEmailed: isStaffReply ? false : dto.isEmailed,
            isThirdParty: dto.isThirdParty,
            creationMode: replyCreationMode,
            messageId: incomingMessageId ?? outboundDraft?.messageId,
            inboundMessageId: incomingMessageId,
            ipAddress: replyIp,
          },
        });

        if (hasNewAttachments && this.attachmentsService) {
          await this.attachmentsService.linkToPost(
            dto.attachmentIds!,
            createdPost.id,
            ticketId,
            undefined,
            tx,
          );
        }

        let attachmentSnapshots: Array<{
          sourceAttachmentId: number;
          fileName: string;
          mimeType: string;
          size: number;
          sha1: string;
          storageKey: string;
        }> = [];
        if (outboundDraft && hasNewAttachments) {
          const attachmentIds = [...new Set(dto.attachmentIds!)];
          const attachments = await tx.attachment.findMany({
            where: { id: { in: attachmentIds }, postId: createdPost.id, ticketId },
            select: {
              id: true,
              fileName: true,
              mimeType: true,
              size: true,
              sha1: true,
              storageKey: true,
            },
          });
          if (attachments.length !== attachmentIds.length) {
            throw new BadRequestException('One or more outbound attachments cannot be snapshotted');
          }
          this.assertOutboundAttachmentBounds(attachments);
          attachmentSnapshots = attachments.map((attachment) => ({
            sourceAttachmentId: attachment.id,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            size: attachment.size,
            sha1: attachment.sha1,
            storageKey: attachment.storageKey,
          }));
        }

        await tx.ticket.update({
          where: { id: ticketId },
          data: {
            totalReplies: { increment: 1 },
            lastReplyAt: now,
            lastActivityAt: now,
            // Set hasAttachments if new attachments were linked
            ...(hasNewAttachments && { hasAttachments: true }),
            ...reopenData,
          },
        });

        await this.writeAudit(ticketId, 'REPLY', staffId, isStaffReply ? 'STAFF' : 'USER', {}, tx);

        const outbox = outboundDraft
          ? await tx.outboundEmail.create({
              data: {
                ticketId,
                postId: createdPost.id,
                emailQueueId: outboundDraft.emailQueueId,
                state: 'QUEUED',
                messageId: outboundDraft.messageId,
                fromAddress: outboundDraft.fromAddress,
                replyToAddress: outboundDraft.replyToAddress,
                subject: outboundDraft.subject,
                htmlBody: outboundDraft.htmlBody,
                textBody: outboundDraft.textBody,
                inReplyTo: outboundDraft.inReplyTo,
                references: outboundDraft.references,
                recipients: { create: outboundDraft.recipients },
                ...(attachmentSnapshots.length ? { attachments: { create: attachmentSnapshots } } : {}),
              },
              select: { id: true },
            })
          : undefined;
        return { post: createdPost, outboundEmailId: outbox?.id };
      });
      post = committed.post;
      outboundEmailId = committed.outboundEmailId;
    } catch (err) {
      if (incomingMessageId && this.isUniqueConstraintViolation(err)) {
        const existing = await this.findPostByInboundMessageId(incomingMessageId);
        if (existing) {
          if (actor && existing.ticketId !== ticketId)
            throw new NotFoundException(`Ticket ${ticketId} not found`);
          return existing;
        }
      }
      throw err;
    }

    if (outboundEmailId) {
      // Redis is only a wake-up accelerator. An enqueue failure leaves the durable
      // row in QUEUED for MailService's startup/periodic DB recovery scan.
      const enqueue = (
        this.mailService as unknown as {
          enqueueOutbound?: (id: string) => Promise<void>;
        }
      ).enqueueOutbound;
      if (enqueue) {
        enqueue
          .call(this.mailService, outboundEmailId)
          .catch((err: unknown) =>
            this.logger.error(
              `Outbox wake-up failed for ticket ${ticket.mask} ` +
                `(${err instanceof Error && err.name ? err.name.slice(0, 80) : 'UnknownError'})`,
            ),
          );
      }
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

  async addNote(
    ticketId: number,
    contents: string,
    staffId?: number,
    attachmentIds?: number[],
    actor?: TicketAccessActor,
  ): Promise<TicketNote> {
    await this.findAccessibleOrThrow(ticketId, actor);
    if (attachmentIds?.length && !this.attachmentsService) {
      throw new BadRequestException('Attachment service is unavailable');
    }
    const hasNoteAttachments = Boolean(attachmentIds?.length);

    return this.prisma.$transaction(async (tx) => {
      const note = await tx.ticketNote.create({
        data: { ticketId, staffId, contents },
      });

      // Link the attachment rows in the same transaction as both the note and
      // ticket metadata, so a failed adoption cannot leave a partial note.
      if (hasNoteAttachments && this.attachmentsService) {
        await this.attachmentsService.linkToNote(attachmentIds!, note.id, ticketId, tx);
      }

      await tx.ticket.update({
        where: { id: ticketId },
        data: {
          hasNotes: true,
          lastActivityAt: new Date(),
          ...(hasNoteAttachments && { hasAttachments: true }),
        },
      });

      await this.writeAudit(ticketId, 'NOTE', staffId, 'STAFF', {}, tx);
      return note;
    });
  }

  // ─────────────────────────── Assign ───────────────────────────

  /**
   * Apply one action (status change or (re)assignment) to many tickets at once.
   * Reuses the per-ticket changeStatus/assign paths so audit logs, SLA side
   * effects and events fire exactly as for a single update. Returns the count
   * of tickets updated; ids that fail (e.g. already gone) are skipped.
   */
  async bulkAction(
    dto: BulkTicketActionDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<{ updated: number; failed: number[] }> {
    // Pre-validate: ids that don't exist (or were merged away) are reported in
    // `failed[]` and never touched. Bulk ops apply a direct field update + audit
    // atomically (no per-ticket notification/event spam — that's by design for a
    // batch); the resolved-status side effect is preserved inline.
    const uniqueIds = [...new Set(dto.ids)];
    const policyWhere = actor ? await this.requireTicketAccess(actor).ticketWhere(actor) : undefined;
    const existing = await this.prisma.ticket.findMany({
      where: policyWhere
        ? {
            AND: [{ id: { in: uniqueIds }, mergedIntoId: null }, policyWhere],
          }
        : { id: { in: uniqueIds }, mergedIntoId: null },
      select: { id: true, departmentId: true, isResolved: true, slaPlanId: true },
    });
    const existingIds = new Set(existing.map((t) => t.id));
    const failed = uniqueIds.filter((id) => !existingIds.has(id));
    // Staff HTTP bulk requests are deliberately all-or-nothing.  Otherwise a
    // single hidden department id would let an agent mutate the visible subset
    // and use `failed[]` as a cross-department existence oracle.
    if (actor && failed.length > 0) {
      throw new NotFoundException('One or more tickets not found');
    }
    if (existing.length === 0) return { updated: 0, failed };

    let status: { markAsResolved: boolean } | null = null;
    if (dto.action === 'status') {
      status = await this.prisma.ticketStatus.findUnique({
        where: { id: dto.statusId! },
        select: { markAsResolved: true },
      });
      if (!status) throw new NotFoundException(`Status ${dto.statusId} not found`);
    }
    // E3: validate the bulk assignee once before the transaction (clean 404 vs FK 500).
    if (dto.action === 'assignee' && dto.ownerStaffId != null) {
      if (actor) {
        await this.requireTicketAccess(actor).assertAssigneeCanHandleDepartments(dto.ownerStaffId, [
          ...new Set(existing.map((ticket) => ticket.departmentId)),
        ]);
      } else {
        await this.assertAssignableStaff(dto.ownerStaffId);
      }
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      for (const t of existing) {
        const data: Record<string, unknown> = { lastActivityAt: now };
        let action: string;
        let newValue: string | null;

        if (dto.action === 'status') {
          data['statusId'] = dto.statusId;
          if (status!.markAsResolved) {
            Object.assign(data, { isResolved: true, resolvedAt: now, dueAt: null, resolutionDueAt: null });
          } else if (t.isResolved) {
            // Reopen on bulk status change away from a resolved state — recompute
            // the SLA clock from now (parity with the single-ticket changeStatus).
            Object.assign(data, { isResolved: false, resolvedAt: null, reopenedAt: now, wasReopened: true });
            if (t.slaPlanId) {
              const due = await this.slaService.computeDueDates(t.slaPlanId, now);
              Object.assign(data, { dueAt: due.dueAt, resolutionDueAt: due.resolutionDueAt });
            }
          }
          action = 'STATUS';
          newValue = String(dto.statusId);
        } else {
          const ownerStaffId = dto.action === 'unassign' ? null : (dto.ownerStaffId ?? null);
          data['ownerStaffId'] = ownerStaffId;
          action = 'ASSIGN';
          newValue = ownerStaffId?.toString() ?? null;
        }

        await tx.ticket.update({ where: { id: t.id }, data });
        await tx.ticketAuditLog.create({
          data: {
            ticketId: t.id,
            staffId,
            actorType: 'STAFF',
            action,
            field: action === 'STATUS' ? 'statusId' : 'ownerStaffId',
            newValue,
          },
        });
      }
    });

    return { updated: existing.length, failed };
  }

  async assign(
    ticketId: number,
    dto: AssignTicketDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const ticket = await this.findAccessibleOrThrow(ticketId, actor);

    // E3: validate the assignee exists (and is enabled) up front — a bad id would
    // otherwise surface as an opaque FK 500 from the update below.
    if (dto.ownerStaffId != null) {
      if (actor) {
        await this.requireTicketAccess(actor).assertAssigneeCanHandleDepartments(dto.ownerStaffId, [
          ticket.departmentId,
        ]);
      } else {
        await this.assertAssignableStaff(dto.ownerStaffId);
      }
    }

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

  async changeStatus(
    ticketId: number,
    dto: ChangeStatusDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const ticket = await this.findAccessibleOrThrow(ticketId, actor);
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

  async changePriority(
    ticketId: number,
    dto: ChangePriorityDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const ticket = await this.findAccessibleOrThrow(ticketId, actor);

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

  async changeType(
    ticketId: number,
    dto: ChangeTypeDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const ticket = await this.findAccessibleOrThrow(ticketId, actor);

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
  async merge(
    sourceTicketId: number,
    dto: MergeTicketDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const source = await this.findAccessibleOrThrow(sourceTicketId, actor);
    const target = await this.findAccessibleOrThrow(dto.targetTicketId, actor);

    if (source.id === target.id) {
      throw new BadRequestException('Cannot merge a ticket into itself');
    }
    if (source.mergedIntoId !== null) {
      throw new BadRequestException(`Ticket ${source.mask} is already merged`);
    }
    // Guard against merging into a ticket that is itself merged away — its posts
    // would be re-parented onto a ghost ticket excluded from all lists (data loss).
    if (target.mergedIntoId !== null) {
      throw new BadRequestException(
        `Ticket ${target.mask} is already merged into another ticket; merge into the active target instead`,
      );
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
  async split(
    sourceTicketId: number,
    dto: SplitTicketDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const source = await this.findAccessibleOrThrow(sourceTicketId, actor);

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

    if (actor) {
      const ticketAccess = this.requireTicketAccess(actor);
      // The actor must be authorized for both the source and the target
      // department: a split is otherwise a cross-department exfiltration path.
      await ticketAccess.assertCanAccessDepartment(actor, departmentId);
      if (source.ownerStaffId != null) {
        await ticketAccess.assertAssigneeCanHandleDepartments(source.ownerStaffId, [departmentId]);
      }
    }

    const now = new Date();

    // Compute SLA due dates for the new ticket
    let dueAt: Date | null = null;
    let resolutionDueAt: Date | null = null;
    if (source.slaPlanId) {
      const dueDates = await this.slaService.computeDueDates(source.slaPlanId, now);
      dueAt = dueDates.dueAt;
      resolutionDueAt = dueDates.resolutionDueAt;
    }

    // Create the new ticket, assign its mask, move the posts, and decrement the
    // source — all in ONE interactive transaction. Previously the create ran
    // outside the transaction, so a failure left an orphan TT-PENDING ticket with
    // no posts. The post move is also scoped to `ticketId: sourceTicketId` so a
    // concurrent split/merge can't let us yank posts that no longer belong to the
    // source (TOCTOU between the verify above and the move).
    const { newTicket, newMask } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.ticket.create({
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
      const mask = formatTicketMask(created.id);
      await tx.ticket.update({ where: { id: created.id }, data: { mask } });
      const moved = await tx.ticketPost.updateMany({
        where: { id: { in: dto.postIds }, ticketId: sourceTicketId },
        data: { ticketId: created.id },
      });
      // Defend the invariant: if a concurrent op moved some posts away between the
      // verify and here, abort the whole transaction rather than split-brain.
      if (moved.count !== dto.postIds.length) {
        throw new BadRequestException('Posts changed during split; please retry');
      }
      await tx.ticket.update({
        where: { id: sourceTicketId },
        data: { totalReplies: { decrement: posts.length }, lastActivityAt: now },
      });
      return { newTicket: created, newMask: mask };
    });

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

  async addWatcher(ticketId: number, dto: WatcherDto, actor?: TicketAccessActor): Promise<void> {
    const ticket = await this.findAccessibleOrThrow(ticketId, actor);
    if (actor) {
      // A watcher receives ticket activity; allowing a restricted staff member
      // to add an out-of-department watcher would leak the same data via
      // notifications even though direct detail access is blocked.
      await this.requireTicketAccess(actor).assertAssigneeCanHandleDepartments(dto.staffId, [
        ticket.departmentId,
      ]);
    }
    await this.prisma.ticketWatcher.upsert({
      where: { ticketId_staffId: { ticketId, staffId: dto.staffId } },
      create: { ticketId, staffId: dto.staffId },
      update: {},
    });
  }

  async removeWatcher(ticketId: number, staffId: number, actor?: TicketAccessActor): Promise<void> {
    if (actor) await this.findAccessibleOrThrow(ticketId, actor);
    await this.prisma.ticketWatcher.deleteMany({ where: { ticketId, staffId } });
  }

  // ─────────────────────────── Ticket links (client ↔ supplier) ─────────────

  /**
   * List every ticket linked to this one, in BOTH directions, flattened to the
   * counterpart ticket + the relationship from this ticket's point of view. This
   * is the backbone of the 23T broker model: a client ticket shows its supplier
   * ticket(s) and vice-versa.
   */
  async listLinks(
    ticketId: number,
    actor?: TicketAccessActor,
  ): Promise<
    Array<{
      linkId: number;
      linkType: string;
      ticket: { id: number; mask: string; subject: string; status: string | null; isResolved: boolean };
    }>
  > {
    await this.findAccessibleOrThrow(ticketId, actor);
    const counterpart = {
      select: {
        id: true,
        mask: true,
        subject: true,
        isResolved: true,
        status: { select: { title: true } },
      },
    } as const;
    const counterpartScope = actor ? await this.requireTicketAccess(actor).ticketWhere(actor) : undefined;
    const links = await this.prisma.ticketLink.findMany({
      where: counterpartScope
        ? {
            OR: [
              { sourceId: ticketId, target: { is: counterpartScope } },
              { targetId: ticketId, source: { is: counterpartScope } },
            ],
          }
        : { OR: [{ sourceId: ticketId }, { targetId: ticketId }] },
      include: { source: counterpart, target: counterpart },
    });
    // Inverse label so the counterpart reads correctly from the other side.
    const inverse: Record<string, string> = { supplier: 'client', client: 'supplier', related: 'related' };
    return links.map((l) => {
      const isSource = l.sourceId === ticketId;
      const other = isSource ? l.target : l.source;
      return {
        linkId: l.id,
        linkType: isSource ? l.linkType : (inverse[l.linkType] ?? l.linkType),
        ticket: {
          id: other.id,
          mask: other.mask,
          subject: other.subject,
          status: other.status?.title ?? null,
          isResolved: other.isResolved,
        },
      };
    });
  }

  async addLink(
    ticketId: number,
    dto: LinkTicketDto,
    actor?: TicketAccessActor,
  ): Promise<{ linkId: number; linkType: string; targetId: number }> {
    if (dto.targetId === ticketId) {
      throw new BadRequestException('A ticket cannot be linked to itself');
    }
    await this.findAccessibleOrThrow(ticketId, actor);
    await this.findAccessibleOrThrow(dto.targetId, actor);

    // Reject a duplicate in either direction (the @@unique only covers one).
    const existing = await this.prisma.ticketLink.findFirst({
      where: {
        OR: [
          { sourceId: ticketId, targetId: dto.targetId },
          { sourceId: dto.targetId, targetId: ticketId },
        ],
      },
    });
    if (existing) throw new BadRequestException('These tickets are already linked');

    const link = await this.prisma.ticketLink.create({
      data: { sourceId: ticketId, targetId: dto.targetId, linkType: dto.linkType },
    });
    return { linkId: link.id, linkType: link.linkType, targetId: link.targetId };
  }

  async removeLink(ticketId: number, linkId: number, actor?: TicketAccessActor): Promise<void> {
    // Scope the delete to links that actually involve this ticket (either end).
    const link = await this.prisma.ticketLink.findUnique({ where: { id: linkId } });
    if (!link || (link.sourceId !== ticketId && link.targetId !== ticketId)) {
      throw new NotFoundException(`Link ${linkId} not found on ticket ${ticketId}`);
    }
    // A link exposes and changes both sides.  Checking just the route ticket
    // would let Department A delete an A↔B relationship without B access.
    if (actor) {
      await this.findAccessibleOrThrow(link.sourceId, actor);
      await this.findAccessibleOrThrow(link.targetId, actor);
    }
    await this.prisma.ticketLink.delete({ where: { id: linkId } });
  }

  /**
   * The core 23T NOC action: from a CLIENT ticket, open a NEW SUPPLIER ticket
   * (type "Vendor Issue" if it exists, requester = the matched carrier) and
   * auto-link it back to the client ticket (`linkType=supplier`). Staff then work
   * the supplier ticket with the "to vendor" macros while the client ticket keeps
   * the "to customer" thread. Returns the spawned supplier ticket.
   */
  async spawnSupplierTicket(
    clientTicketId: number,
    dto: SpawnSupplierDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<{ ticket: Ticket; linkId: number; clientTicketId: number }> {
    const client = await this.findAccessibleOrThrow(clientTicketId, actor);
    // Prefer a "Vendor Issue" type; fall back to leaving it unset.
    const vendorType = await this.prisma.ticketType.findFirst({
      where: { title: { in: ['Vendor Issue', 'Vendor', 'Supplier Issue'] } },
      select: { id: true },
    });

    const supplierInput = {
      subject: dto.subject ?? `[Supplier] ${client.subject}`,
      contents: dto.contents,
      isHtml: false,
      departmentId: client.departmentId,
      ...(vendorType ? { typeId: vendorType.id } : {}),
      requesterEmail: dto.supplierEmail,
      requesterName: dto.supplierName ?? '',
      creationMode: 'STAFF' as const,
      ipAddress: '0.0.0.0',
      customFields: {},
      tags: [],
    };
    const supplier = actor
      ? await this.createTicket(supplierInput, staffId, actor)
      : await this.createTicket(supplierInput, staffId);

    const link = actor
      ? await this.addLink(clientTicketId, { targetId: supplier.id, linkType: 'supplier' }, actor)
      : await this.addLink(clientTicketId, { targetId: supplier.id, linkType: 'supplier' });
    return { ticket: supplier, linkId: link.linkId, clientTicketId };
  }

  // ─────────────────────────── Tags ───────────────────────────

  async addTag(ticketId: number, dto: TagDto, actor?: TicketAccessActor): Promise<void> {
    await this.findAccessibleOrThrow(ticketId, actor);
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

  async removeTag(ticketId: number, tagName: string, actor?: TicketAccessActor): Promise<void> {
    await this.findAccessibleOrThrow(ticketId, actor);
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
  async applyMacro(
    ticketId: number,
    dto: ApplyMacroDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const ticket = await this.findAccessibleOrThrow(ticketId, actor);

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
        // The workflow/macro UI stores the target as a string `value` (e.g.
        // {type:'set_status', value:'3'}); older/event-driven shapes use a typed
        // key (statusId). Accept both so UI-built macros actually fire.
        const numField = (key: string): number | undefined => {
          const raw = action[key] ?? action['value'];
          const n = typeof raw === 'string' ? Number(raw) : (raw as number | undefined);
          return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
        };
        try {
          switch (type) {
            case 'set_status':
            case 'change_status': {
              const sid = numField('statusId');
              if (sid) ticketUpdate['statusId'] = sid;
              break;
            }
            case 'set_priority':
            case 'change_priority': {
              const pid = numField('priorityId');
              if (pid) ticketUpdate['priorityId'] = pid;
              break;
            }
            case 'assign':
            case 'change_owner':
              ticketUpdate['ownerStaffId'] = action['ownerStaffId'] ?? numField('ownerStaffId') ?? null;
              break;
            case 'change_department': {
              const did = numField('departmentId');
              if (did) ticketUpdate['departmentId'] = did;
              break;
            }
            case 'add_tag': {
              // Accept both the typed key (`tag`) and the UI's generic `value`.
              // H8-8: cap the length so a macro can't create an absurd tag.
              const tag = ((action['tag'] ?? action['value']) as string | undefined)?.slice(0, 100);
              if (typeof tag === 'string' && tag) {
                await this.prisma.ticket.update({
                  where: { id: ticketId },
                  data: {
                    tags: {
                      connectOrCreate: {
                        where: { name: tag },
                        create: { name: tag },
                      },
                    },
                  },
                });
              }
              break;
            }
            case 'add_note': {
              // Accept both the typed key (`note`) and the UI's generic `value`.
              // H8-8: cap the note length (defensive against an oversized macro).
              const note = ((action['note'] ?? action['value']) as string | undefined)?.slice(0, 5000);
              if (typeof note === 'string' && note) {
                await this.prisma.ticketNote.create({
                  data: {
                    ticketId,
                    staffId,
                    contents: `[Macro: ${macro.title}] ${note}`,
                  },
                });
              }
              break;
            }
          }
        } catch (err) {
          this.logger.error(
            `Macro ${macro.id} action ${type ?? 'unknown'} failed on ticket ${ticket.mask}: ${String(err)}`,
          );
        }
      }

      // Route EVERY accumulated change through its validated helper so existence
      // is checked and the proper audit / notification / SLA side effects fire
      // (H8-1 assign notification, H8-5 id validation) — never a raw FK-blind update.
      if (ticketUpdate['statusId']) {
        const sid = ticketUpdate['statusId'] as number;
        if (await this.prisma.ticketStatus.findUnique({ where: { id: sid } })) {
          if (actor) await this.changeStatus(ticketId, { statusId: sid }, staffId, actor);
          else await this.changeStatus(ticketId, { statusId: sid }, staffId);
        } else {
          this.logger.warn(`Macro ${macro.id}: skipped set_status — status ${sid} not found`);
        }
      }
      if (ticketUpdate['priorityId']) {
        const pid = ticketUpdate['priorityId'] as number;
        if (await this.prisma.ticketPriority.findUnique({ where: { id: pid } })) {
          if (actor) await this.changePriority(ticketId, { priorityId: pid }, staffId, actor);
          else await this.changePriority(ticketId, { priorityId: pid }, staffId);
        } else {
          this.logger.warn(`Macro ${macro.id}: skipped set_priority — priority ${pid} not found`);
        }
      }
      if (ticketUpdate['departmentId']) {
        const did = ticketUpdate['departmentId'] as number;
        if (await this.prisma.department.findUnique({ where: { id: did } })) {
          if (actor) await this.changeDepartment(ticketId, { departmentId: did }, staffId, actor);
          else await this.changeDepartment(ticketId, { departmentId: did }, staffId);
        } else {
          this.logger.warn(`Macro ${macro.id}: skipped change_department — department ${did} not found`);
        }
      }
      if ('ownerStaffId' in ticketUpdate) {
        const oid = ticketUpdate['ownerStaffId'] as number | null;
        if (oid == null) {
          if (actor) await this.assign(ticketId, { ownerStaffId: null }, staffId, actor);
          else await this.assign(ticketId, { ownerStaffId: null }, staffId);
        } else if (await this.prisma.staff.findUnique({ where: { id: oid } })) {
          if (actor) await this.assign(ticketId, { ownerStaffId: oid }, staffId, actor);
          else await this.assign(ticketId, { ownerStaffId: oid }, staffId);
        } else {
          this.logger.warn(`Macro ${macro.id}: skipped assign — staff ${oid} not found`);
        }
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
  async changeDepartment(
    ticketId: number,
    dto: ChangeDepartmentDto,
    staffId: number,
    actor?: TicketAccessActor,
  ): Promise<Ticket> {
    const ticket = await this.findAccessibleOrThrow(ticketId, actor);

    if (actor) {
      const ticketAccess = this.requireTicketAccess(actor);
      await ticketAccess.assertCanAccessDepartment(actor, dto.departmentId);
      if (ticket.ownerStaffId != null) {
        await ticketAccess.assertAssigneeCanHandleDepartments(ticket.ownerStaffId, [dto.departmentId]);
      }
    }

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

  private async prepareStaffReplyOutboxDraft(
    ticket: Ticket,
    dto: InternalReplyTicketInput,
    staffId: number,
    _authorName?: string,
    _authorEmail?: string,
  ): Promise<StaffReplyOutboxDraft> {
    const [storedRecipients, staff, queue, threadingIds] = await Promise.all([
      this.prisma.ticketRecipient.findMany({ where: { ticketId: ticket.id } }),
      this.prisma.staff.findUnique({ where: { id: staffId }, select: { signature: true } }),
      this.prisma.emailQueue.findFirst({
        where: { departmentId: ticket.departmentId, isEnabled: true },
        orderBy: { id: 'asc' },
        select: { id: true, emailAddress: true, signature: true },
      }),
      this.loadThreadingIds(ticket.id),
    ]);

    const signature = [staff?.signature, queue?.signature]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))
      .join('\n\n');
    const contents = signature ? `${dto.contents}\n\n--\n${signature}` : dto.contents;
    const requesterName = ticket.requesterName || ticket.requesterEmail;
    const rendered = await this.renderStaffReplyTemplate({
      mask: ticket.mask,
      subject: ticket.subject,
      contents,
      name: requesterName,
      requesterName,
    });

    return {
      messageId: this.createOutboundMessageId(),
      emailQueueId: queue?.id ?? null,
      fromAddress: this.outboundFromAddress(),
      replyToAddress: queue?.emailAddress ?? null,
      subject: rendered.subject,
      htmlBody: rendered.html,
      textBody: rendered.text,
      inReplyTo: threadingIds.at(-1) ?? null,
      references: threadingIds,
      recipients: this.normalizeOutboundRecipients(ticket.requesterEmail, dto, storedRecipients),
    };
  }

  private async loadThreadingIds(ticketId: number): Promise<string[]> {
    // The optional guard is useful for narrow unit doubles; a real Prisma client
    // always has findMany and keeps a bounded chain for RFC threading.
    const repository = this.prisma.ticketPost as unknown as {
      findMany?: (args: unknown) => Promise<Array<{ messageId: string | null }> | undefined>;
    };
    if (!repository.findMany) return [];
    const posts =
      (await repository.findMany({
        where: { ticketId, messageId: { not: null }, NOT: { messageId: '' } },
        select: { messageId: true },
        orderBy: { createdAt: 'asc' },
        take: 20,
      })) ?? [];
    const validIds = posts
      .map((post) => this.parseMessageId(post.messageId))
      .filter((messageId): messageId is string => Boolean(messageId));

    // Keep a chronological suffix: References is a chain, so retaining an
    // older ID after dropping a newer one would create a misleading thread.
    // Work backwards so the newest valid ID remains In-Reply-To whenever it
    // fits, then reverse it back into chronological order for the DB snapshot.
    const newestFirst: string[] = [];
    let referenceChars = 0;
    for (const messageId of [...validIds].reverse()) {
      const addedChars = messageId.length + (newestFirst.length > 0 ? 1 : 0);
      if (referenceChars + addedChars > MAX_OUTBOUND_REFERENCES_CHARS) break;
      newestFirst.push(messageId);
      referenceChars += addedChars;
    }
    return newestFirst.reverse();
  }

  private async renderStaffReplyTemplate(vars: Record<string, string>): Promise<{
    subject: string;
    html: string;
    text: string;
  }> {
    const renderer = this.mailService as unknown as {
      renderTemplateRequired?: (
        key: string,
        locale: string,
        variables: Record<string, string>,
      ) => Promise<{ subject: string; html: string; text: string }>;
      renderTemplate?: (
        key: string,
        locale: string,
        variables: Record<string, string>,
      ) => Promise<{ subject: string; html: string; text: string }>;
    };
    if (renderer.renderTemplateRequired) {
      return renderer.renderTemplateRequired('ticket_user_reply', 'en', vars);
    }
    if (renderer.renderTemplate) {
      return renderer.renderTemplate('ticket_user_reply', 'en', vars);
    }
    // Test doubles and a deliberately minimal emergency construction still get a
    // useful plain snapshot rather than serialising variables as JSON. Production
    // MailService always provides renderTemplate.
    return {
      subject: `Re: [${vars['mask']}] ${vars['subject']}`,
      html: vars['contents'] ?? '',
      text: vars['contents'] ?? '',
    };
  }

  private normalizeOutboundRecipients(
    requesterEmail: string,
    dto: InternalReplyTicketInput,
    storedRecipients: Array<{ email: string; role: 'CC' | 'BCC' }>,
  ): Array<{ email: string; role: 'TO' | 'CC' | 'BCC' }> {
    const recipients = new Map<string, 'TO' | 'CC' | 'BCC'>();
    const add = (email: string | undefined, role: 'TO' | 'CC' | 'BCC'): void => {
      if (!email) return;
      const normalized = normalizeEmail(email);
      if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(normalized)) {
        if (role === 'TO') throw new BadRequestException('Requester email is invalid for outbound delivery');
        return; // A malformed historic CC/BCC row must not poison the main reply.
      }
      const existing = recipients.get(normalized);
      // TO takes precedence over all, CC takes precedence over BCC. That makes a
      // recipient visible only when explicitly chosen visible and never leaks BCC.
      if (!existing || (existing === 'BCC' && role !== 'BCC')) recipients.set(normalized, role);
    };
    add(requesterEmail, 'TO');
    for (const email of [
      ...(dto.ccEmails ?? []),
      ...storedRecipients.filter((r) => r.role === 'CC').map((r) => r.email),
    ]) {
      add(email, 'CC');
    }
    for (const email of [
      ...(dto.bccEmails ?? []),
      ...storedRecipients.filter((r) => r.role === 'BCC').map((r) => r.email),
    ]) {
      add(email, 'BCC');
    }
    if (![...recipients.values()].includes('TO')) {
      throw new BadRequestException('A public staff reply requires a requester recipient');
    }
    return [...recipients.entries()].map(([email, role]) => ({ email, role }));
  }

  private assertOutboundAttachmentBounds(attachments: Array<{ id: number; size: number }>): void {
    const MAX_OUTBOUND_ATTACHMENTS = 10;
    const MAX_OUTBOUND_ATTACHMENT_BYTES = 25 * 1024 * 1024;
    const totalBytes = attachments.reduce((total, attachment) => total + attachment.size, 0);
    if (attachments.length > MAX_OUTBOUND_ATTACHMENTS || totalBytes > MAX_OUTBOUND_ATTACHMENT_BYTES) {
      throw new BadRequestException('Outbound attachment count or size limit exceeded');
    }
  }

  private outboundFromAddress(): string {
    const mail = this.mailService as unknown as { getDefaultFromAddress?: () => string };
    return mail.getDefaultFromAddress?.() ?? 'support@23telecom.invalid';
  }

  private createOutboundMessageId(): string {
    const from = this.outboundFromAddress();
    const address = /<([^>]+)>/.exec(from)?.[1] ?? from;
    const domain = address.split('@')[1]?.trim().toLowerCase();
    const safeDomain = domain && /^[a-z0-9.-]+$/i.test(domain) ? domain : '23telecom.invalid';
    return `<${randomUUID()}@${safeDomain}>`;
  }

  private async findOrThrow(id: number): Promise<Ticket> {
    const t = await this.prisma.ticket.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`Ticket ${id} not found`);
    return t;
  }

  /**
   * Trusted mail/workflow calls deliberately omit an actor and retain their
   * system path.  Every staff HTTP controller supplies one; fail closed if its
   * policy provider is unexpectedly absent rather than silently falling back to
   * an unscoped lookup.
   */
  private requireTicketAccess(actor: TicketAccessActor): TicketAccessPolicy {
    if (this.ticketAccess) return this.ticketAccess;
    throw new ServiceUnavailableException(`Ticket access policy is unavailable for staff ${actor.staffId}`);
  }

  private async findAccessibleOrThrow(id: number, actor?: TicketAccessActor): Promise<Ticket> {
    if (!actor) return this.findOrThrow(id);
    const ticket = await this.prisma.ticket.findFirst({
      where: {
        AND: [{ id }, await this.requireTicketAccess(actor).ticketWhere(actor)],
      },
    });
    if (!ticket) throw new NotFoundException(`Ticket ${id} not found`);
    return ticket;
  }

  /** E3: a ticket can only be assigned to an existing, enabled staff member. */
  private async assertAssignableStaff(staffId: number): Promise<void> {
    const staff = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: { id: true, isEnabled: true },
    });
    if (!staff) throw new NotFoundException(`Staff ${staffId} not found`);
    if (!staff.isEnabled)
      throw new BadRequestException(`Staff ${staffId} is disabled and cannot be assigned`);
  }

  /** Normalize an untrusted RFC header before it reaches the idempotency index. */
  private normalizeIncomingMessageId(messageId?: string): string | undefined {
    const normalized = messageId?.trim();
    if (!normalized) return undefined;
    if (!this.parseMessageId(normalized, 998)) throw new BadRequestException('Invalid inbound Message-ID');
    return normalized;
  }

  /**
   * Validate a Message-ID before it is persisted or emitted as an SMTP header.
   * Unlike inbound input validation, callers that read a legacy database row
   * receive `undefined` rather than an exception: one corrupt historic post
   * must not prevent an agent from replying to the ticket.
   */
  private parseMessageId(
    value: string | null | undefined,
    maxLength = MAX_OUTBOUND_THREADING_MESSAGE_ID_CHARS,
  ): string | undefined {
    const normalized = value?.trim();
    if (
      !normalized ||
      normalized.length > maxLength ||
      !normalized.startsWith('<') ||
      !normalized.endsWith('>')
    ) {
      return undefined;
    }
    const body = normalized.slice(1, -1);
    if (!body) return undefined;
    for (const character of body) {
      const codePoint = character.codePointAt(0) ?? 0;
      if (
        character === '<' ||
        character === '>' ||
        /\s/u.test(character) ||
        codePoint <= 0x1f ||
        codePoint === 0x7f
      ) {
        return undefined;
      }
    }
    return normalized;
  }

  private findPostByInboundMessageId(messageId: string): Promise<TicketPost | null> {
    return this.prisma.ticketPost.findFirst({ where: { inboundMessageId: messageId } });
  }

  private async findTicketByInboundMessageId(messageId: string): Promise<Ticket | null> {
    const post = await this.prisma.ticketPost.findFirst({
      where: { inboundMessageId: messageId },
      select: { ticketId: true },
    });
    if (!post) return null;
    return this.prisma.ticket.findUnique({ where: { id: post.ticketId } });
  }

  private isUniqueConstraintViolation(err: unknown): boolean {
    return (err as { code?: unknown } | null)?.code === 'P2002';
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
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = transaction ?? this.prisma;
    await client.ticketAuditLog.create({
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
