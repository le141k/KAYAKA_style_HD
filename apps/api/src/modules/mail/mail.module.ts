import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { InboundMailService } from './inbound.service';
import { TicketsModule } from '../tickets/tickets.module';
import { loadConfig, APP_CONFIG } from '../../config/configuration';

@Module({
  imports: [TicketsModule],
  providers: [
    { provide: APP_CONFIG, useValue: loadConfig() },
    MailService,
    InboundMailService,
  ],
  exports: [MailService],
})
export class MailModule {}
