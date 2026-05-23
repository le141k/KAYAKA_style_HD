import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MailService } from './mail.service';
import { MailProcessor } from './mail.processor';
import { InboundMailService } from './inbound.service';
import { EmailQueueService } from './email-queue.service';
import { EmailQueueController } from './email-queue.controller';
import { TicketsModule } from '../tickets/tickets.module';
import { loadConfig, APP_CONFIG } from '../../config/configuration';

@Module({
  imports: [forwardRef(() => TicketsModule), BullModule.registerQueue({ name: 'mail' })],
  controllers: [EmailQueueController],
  providers: [
    { provide: APP_CONFIG, useValue: loadConfig() },
    MailService,
    MailProcessor,
    InboundMailService,
    EmailQueueService,
  ],
  exports: [MailService],
})
export class MailModule {}
