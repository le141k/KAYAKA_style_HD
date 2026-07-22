import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { enqueueWorkflowEmailEvent } from './workflow-email-event.service';

/**
 * BullMQ processor for the 'workflow' queue.
 * Handles the 'auto-close' repeatable job that closes idle pending tickets.
 *
 * Auto-close threshold: tickets in pending status with lastActivityAt older than
 * TELECOM_HD_AUTO_CLOSE_DAYS days (default 7).
 */
@Processor('workflow')
export class AutoCloseProcessor extends WorkerHost {
  private readonly logger = new Logger(AutoCloseProcessor.name);

  /** Number of idle days before a pending ticket is auto-closed */
  private readonly idleDays = 7;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'auto-close') return;

    this.logger.debug('Auto-close job started');

    const cutoff = new Date(Date.now() - this.idleDays * 24 * 60 * 60 * 1000);

    // Find the "Pending" status
    const pendingStatus = await this.prisma.ticketStatus.findFirst({
      where: { title: { contains: 'Pending', mode: 'insensitive' } },
    });
    if (!pendingStatus) {
      this.logger.debug('No Pending status found — skipping auto-close');
      return;
    }

    // Find "Closed" or "Resolved" status to close into
    const closedStatus = await this.prisma.ticketStatus.findFirst({
      where: { markAsResolved: true },
      orderBy: { displayOrder: 'asc' },
    });
    if (!closedStatus) {
      this.logger.debug('No resolved status found — skipping auto-close');
      return;
    }

    // Find idle pending tickets
    const idleTickets = await this.prisma.ticket.findMany({
      where: {
        statusId: pendingStatus.id,
        isResolved: false,
        mergedIntoId: null,
        lastActivityAt: { lt: cutoff },
      },
      take: 100, // process in batches
    });

    if (idleTickets.length === 0) {
      this.logger.debug('No idle tickets to auto-close');
      return;
    }

    this.logger.log(`Auto-closing ${idleTickets.length} idle ticket(s)`);

    for (const ticket of idleTickets) {
      try {
        const committed = await this.prisma.$transaction(async (tx) => {
          const now = new Date();
          // The scan is only a candidate list. This CAS is the actual close fence:
          // a second worker, staff reply or status edit wins without a duplicate
          // closure/audit/customer email.
          const closed = await tx.ticket.updateMany({
            where: {
              id: ticket.id,
              statusId: pendingStatus.id,
              isResolved: false,
              mergedIntoId: null,
              lastActivityAt: { lt: cutoff },
            },
            data: {
              statusId: closedStatus.id,
              isResolved: true,
              resolvedAt: now,
              lastActivityAt: now,
            },
          });
          if (closed.count !== 1) return null;

          // This immutable audit row fences both the auto-close acknowledgement
          // and the generic status-change workflow event.  All three commands
          // belong to the same close transaction: an error must roll back the
          // status change rather than silently omit one customer-facing action.
          const audit = await tx.ticketAuditLog.create({
            data: {
              ticketId: ticket.id,
              actorType: 'SYSTEM',
              action: 'AUTO_CLOSE',
              field: 'statusId',
              oldValue: pendingStatus.id.toString(),
              newValue: closedStatus.id.toString(),
            },
            select: { id: true },
          });

          const closedTicket = {
            ...ticket,
            statusId: closedStatus.id,
            isResolved: true,
            resolvedAt: now,
            lastActivityAt: now,
          };
          await enqueueWorkflowEmailEvent(
            tx,
            closedTicket,
            'ticket.status_changed',
            `ticket-audit:${audit.id}`,
          );

          const outboxId = ticket.requesterEmail
            ? (
                await this.mailService.createAutomatedTicketEmail(tx, {
                  ticketId: ticket.id,
                  kind: 'AUTO_CLOSE',
                  templateKey: 'ticket_auto_closed',
                  locale: 'en',
                  to: ticket.requesterEmail,
                  vars: {
                    mask: ticket.mask,
                    subject: ticket.subject,
                    name: ticket.requesterName || ticket.requesterEmail,
                  },
                })
              ).id
            : undefined;
          return { outboxId, ticketId: ticket.id };
        });
        if (committed) {
          if (committed.outboxId) {
            this.mailService
              .enqueueOutbound(committed.outboxId)
              .catch((err: unknown) =>
                this.logger.error(
                  `Auto-close outbox wake-up failed for ticket ${ticket.mask} ` +
                    `(${err instanceof Error && err.name ? err.name.slice(0, 80) : 'UnknownError'})`,
                ),
              );
          }
          // Mirrors TicketsService.changeStatus: scalar workflow actions must
          // observe an auto-close too, but only after its durable transaction
          // commits. The workflow-email event above is already durable and is
          // intentionally distinct from the AUTO_CLOSE acknowledgement.
          this.eventEmitter.emit('ticket.status_changed', { ticketId: committed.ticketId });
        }
      } catch (err) {
        this.logger.error(`Failed to auto-close ticket ${ticket.mask}: ${String(err)}`);
      }
    }
  }
}
