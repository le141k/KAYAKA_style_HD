import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SlaService } from './sla.service';
import { SlaProcessor } from './sla.processor';
import { SlaScheduleController, SlaPlansController } from './sla.controller';
import { MailModule } from '../mail/mail.module';

/**
 * SLA module.
 *
 * Provides SlaService for use by TicketsModule and MailModule.
 * Registers a BullMQ 'sla' queue with a repeatable 60-second job
 * that triggers SlaService.runPeriodicCheck().
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'sla' }), MailModule],
  controllers: [SlaScheduleController, SlaPlansController],
  providers: [SlaService, SlaProcessor],
  exports: [SlaService],
})
export class SlaModule {}
