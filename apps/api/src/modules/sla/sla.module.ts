import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
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
export class SlaModule implements OnModuleInit {
  private readonly logger = new Logger(SlaModule.name);

  constructor(@InjectQueue('sla') private readonly slaQueue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.slaQueue.add(
      'scan',
      {},
      {
        jobId: 'sla-scan-repeatable',
        repeat: { every: 60_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log('SLA repeatable scan job scheduled (every 60s)');
  }
}
