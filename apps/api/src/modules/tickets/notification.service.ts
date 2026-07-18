import { Injectable, Logger, Optional } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Notification service for staff-facing notifications.
 * Handles assignment notifications and watcher notifications on user replies.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly mailService?: MailService,
  ) {}

  /**
   * Send assignment notification email to the newly assigned staff member.
   * Template key: notify_staff_assigned
   */
  async notifyOnAssign(ticketId: number, staffId: number): Promise<void> {
    if (!this.mailService) return;

    try {
      const [ticket, staff] = await Promise.all([
        this.prisma.ticket.findUnique({ where: { id: ticketId } }),
        this.prisma.staff.findUnique({ where: { id: staffId } }),
      ]);

      if (!ticket || !staff) return;
      if (!staff.email) return;

      const staffName = `${staff.firstName} ${staff.lastName}`.trim() || staff.email;

      await this.mailService.sendTemplate(staff.email, 'notify_staff_assigned', 'en', {
        mask: ticket.mask,
        subject: ticket.subject,
        name: staffName,
        staffName,
      });

      this.logger.debug(`Assignment notification sent for ticket ${ticket.mask}`);
    } catch (err) {
      this.logger.error(`Failed to send assignment notification for ticket ${ticketId}: ${String(err)}`);
    }
  }

  /**
   * Send reply notification to all enabled watchers of a ticket
   * when a USER (customer) posts a reply.
   * Template key: notify_staff_user_replied
   */
  async notifyWatchersOnUserReply(ticketId: number): Promise<void> {
    if (!this.mailService) return;

    try {
      const ticket = await this.prisma.ticket.findUnique({ where: { id: ticketId } });
      if (!ticket) return;

      // Load watchers with their staff details
      const watchers = await this.prisma.ticketWatcher.findMany({
        where: { ticketId },
        include: {
          staff: { select: { id: true, email: true, firstName: true, lastName: true, isEnabled: true } },
        },
      });

      const enabledWatchers = watchers.filter((w) => w.staff.isEnabled);

      await Promise.all(
        enabledWatchers.map(async (w) => {
          const staffName = `${w.staff.firstName} ${w.staff.lastName}`.trim() || w.staff.email;
          try {
            await this.mailService!.sendTemplate(w.staff.email, 'notify_staff_user_replied', 'en', {
              mask: ticket.mask,
              subject: ticket.subject,
              name: staffName,
              staffName,
            });
          } catch {
            this.logger.error(`Failed to send watcher notification for ticket ${ticket.mask}`);
          }
        }),
      );

      if (enabledWatchers.length > 0) {
        this.logger.debug(
          `Watcher notifications sent to ${enabledWatchers.length} staff for ticket ${ticket.mask}`,
        );
      }
    } catch (err) {
      this.logger.error(`Failed to send watcher notifications for ticket ${ticketId}: ${String(err)}`);
    }
  }
}
