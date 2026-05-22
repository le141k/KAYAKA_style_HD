import { Module } from '@nestjs/common';
import { SlaService } from './sla.service';

/**
 * SLA module.
 *
 * The BullMQ queue 'sla' is registered in AppModule (root BullMQ config).
 * A processor that periodically calls SlaService.runPeriodicCheck() should be
 * registered here once @nestjs/bullmq is wired. Example:
 *
 *   import { BullModule } from '@nestjs/bullmq';
 *   BullModule.registerQueue({ name: 'sla' })
 *
 * For now, the cron-like check can be triggered via a simple
 * @nestjs/schedule @Cron on a SlaProcessor class — TODO once scheduler is added.
 */
@Module({
  providers: [SlaService],
  exports: [SlaService],
})
export class SlaModule {}
