import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Ticket } from '@prisma/client';
import { MailService } from '../mail/mail.service';

type TicketNotificationSnapshot = Pick<Ticket, 'id' | 'mask' | 'subject' | 'departmentId'>;

/**
 * Transactional staff-notification planner.
 *
 * This class deliberately never calls `sendTemplate()`: SMTP is an asynchronous
 * effect and must be represented by an immutable OutboundEmail command before
 * the ticket/post/audit transaction commits.  Callers enqueue the returned ids
 * only after commit; MailService's DB recovery scan handles a failed wake-up.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    // Required in real DI: a missing adapter must abort the source transaction
    // rather than make a committed ticket look as though it notified staff.
    private readonly mailService: MailService,
  ) {}

  /**
   * Queue the assignee alert alongside its assignment audit. `sourceKey` must
   * contain a server-created audit/event id, never a client-controlled value.
   */
  async queueAssignmentNotification(
    tx: Prisma.TransactionClient,
    ticket: TicketNotificationSnapshot,
    staffId: number,
    sourceKey: string,
  ): Promise<string | undefined> {
    const staff = await tx.staff.findUnique({
      where: { id: staffId },
      include: {
        staffGroup: { select: { isAdmin: true } },
        departments: { select: { departmentId: true } },
      },
    });
    if (!staff?.isEnabled || !staff.email) return undefined;

    // A notification must not become a second stale authorization channel when
    // an assignee loses membership during a concurrent ticket move/revocation.
    if (
      !staff.staffGroup.isAdmin &&
      !staff.departments.some((membership) => membership.departmentId === ticket.departmentId)
    ) {
      this.logger.warn(`Skipped out-of-scope assignment notification for ticket ${ticket.id}`);
      return undefined;
    }

    const staffName = `${staff.firstName} ${staff.lastName}`.trim() || staff.email;
    const command = await this.requireMailService().createInternalNotificationEmail(tx, {
      ticketId: ticket.id,
      templateKey: 'notify_staff_assigned',
      locale: 'en',
      to: staff.email,
      vars: {
        mask: ticket.mask,
        subject: ticket.subject,
        name: staffName,
        staffName,
      },
      idempotencyKey: `internal:assignment:${sourceKey}:staff:${staff.id}`,
    });
    return command.id;
  }

  /**
   * Queue one immutable alert per currently eligible watcher.  The TicketPost
   * id is the business event fence, so a delivery retry cannot create a second
   * email for the same watcher/user reply.
   */
  async queueWatcherNotificationsForUserReply(
    tx: Prisma.TransactionClient,
    ticket: TicketNotificationSnapshot,
    postId: number,
  ): Promise<string[]> {
    if (!Number.isInteger(postId) || postId <= 0) {
      throw new Error('Watcher notification source post id is invalid');
    }
    const watchers = await tx.ticketWatcher.findMany({
      where: {
        ticketId: ticket.id,
        staff: {
          is: {
            isEnabled: true,
            OR: [
              { staffGroup: { is: { isAdmin: true } } },
              { departments: { some: { departmentId: ticket.departmentId } } },
            ],
          },
        },
      },
      include: {
        staff: { select: { id: true, email: true, firstName: true, lastName: true, isEnabled: true } },
      },
      orderBy: { staffId: 'asc' },
    });

    const mail = this.requireMailService();
    const commandIds: string[] = [];
    for (const watcher of watchers) {
      // Defensive projection guard for historic test doubles and a nullable
      // email; the relational predicate above is the source of truth.
      if (!watcher.staff.isEnabled || !watcher.staff.email) continue;
      const staffName = `${watcher.staff.firstName} ${watcher.staff.lastName}`.trim() || watcher.staff.email;
      const command = await mail.createInternalNotificationEmail(tx, {
        ticketId: ticket.id,
        templateKey: 'notify_staff_user_replied',
        locale: 'en',
        to: watcher.staff.email,
        vars: {
          mask: ticket.mask,
          subject: ticket.subject,
          name: staffName,
          staffName,
        },
        idempotencyKey: `internal:watcher-reply:post:${postId}:staff:${watcher.staff.id}`,
      });
      commandIds.push(command.id);
    }
    return commandIds;
  }

  /** Best-effort low-latency wake-up after the surrounding transaction commits. */
  wakeCommittedNotifications(ids: Iterable<string>): void {
    const mail = this.mailService;
    for (const id of new Set(ids)) {
      void mail
        .enqueueOutbound(id)
        .catch((err: unknown) =>
          this.logger.error(
            `Internal notification outbox wake-up failed for ${id}: ` +
              `${err instanceof Error && err.name ? err.name.slice(0, 80) : 'UnknownError'}`,
          ),
        );
    }
  }

  private requireMailService(): MailService {
    return this.mailService;
  }
}
