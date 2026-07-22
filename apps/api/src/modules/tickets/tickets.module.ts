import { forwardRef, Module } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { RecipientsController } from './recipients.controller';
import { ReferenceService } from './reference.service';
import { ReferenceController } from './reference.controller';
import { NotificationService } from './notification.service';
import { UsersModule } from '../users/users.module';
import { SlaModule } from '../sla/sla.module';
import { MailModule } from '../mail/mail.module';
import { AdminModule } from '../admin/admin.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { ClientAuthModule } from '../client-auth/client-auth.module';
import { TicketAccessModule } from './ticket-access.module';

@Module({
  imports: [
    UsersModule,
    SlaModule,
    forwardRef(() => MailModule),
    AdminModule,
    AttachmentsModule,
    ClientAuthModule,
    TicketAccessModule,
  ],
  controllers: [TicketsController, ReferenceController, RecipientsController],
  providers: [TicketsService, ReferenceService, NotificationService],
  exports: [TicketsService],
})
export class TicketsModule {}
