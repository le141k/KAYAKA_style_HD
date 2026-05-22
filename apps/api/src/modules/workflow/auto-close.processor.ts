import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

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
        await this.prisma.ticket.update({
          where: { id: ticket.id },
          data: {
            statusId: closedStatus.id,
            isResolved: true,
            resolvedAt: new Date(),
            lastActivityAt: new Date(),
          },
        });

        await this.prisma.ticketAuditLog.create({
          data: {
            ticketId: ticket.id,
            actorType: 'SYSTEM',
            action: 'AUTO_CLOSE',
            field: 'statusId',
            oldValue: pendingStatus.id.toString(),
            newValue: closedStatus.id.toString(),
          },
        });

        // Send autoresponder
        if (ticket.requesterEmail) {
          await this.mailService.sendTemplate(ticket.requesterEmail, 'autoresponder', 'en', {
            mask: ticket.mask,
            subject: ticket.subject,
            name: ticket.requesterName || ticket.requesterEmail,
          });
        }
      } catch (err) {
        this.logger.error(`Failed to auto-close ticket ${ticket.mask}: ${String(err)}`);
      }
    }
  }
}
