import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MailService } from './mail.service';
import { MailProcessor } from './mail.processor';
import { InboundMailService } from './inbound.service';
import { EmailQueueService } from './email-queue.service';
import { InboundAuditService } from './inbound-audit.service';
import { InboundRawStorageService } from './inbound-raw-storage.service';
import { EmailQueueController } from './email-queue.controller';
import { ParserRulesController } from './parser-rules.controller';
import { InboundController } from './inbound.controller';
import { TicketsModule } from '../tickets/tickets.module';
import { AttachmentsModule } from '../attachments/attachments.module';
import { loadConfig, APP_CONFIG } from '../../config/configuration';

@Module({
  imports: [forwardRef(() => TicketsModule), BullModule.registerQueue({ name: 'mail' }), AttachmentsModule],
  controllers: [EmailQueueController, ParserRulesController, InboundController],
  providers: [
    { provide: APP_CONFIG, useValue: loadConfig() },
    MailService,
    MailProcessor,
    InboundMailService,
    EmailQueueService,
    InboundAuditService,
    InboundRawStorageService,
  ],
  exports: [MailService],
})
export class MailModule {}
