import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SlaService } from './sla.service';

/**
 * BullMQ processor for the 'sla' queue.
 * Consumes repeatable 'scan' jobs to run periodic SLA breach checks.
 *
 * concurrency:1 + a long lockDuration so two scans can't overlap (a scan can run
 * longer than the 60s repeat interval at scale and would otherwise double-fire).
 */
@Processor('sla', { concurrency: 1, lockDuration: 120_000 })
export class SlaProcessor extends WorkerHost {
  private readonly logger = new Logger(SlaProcessor.name);

  constructor(private readonly slaService: SlaService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.debug(`SLA queue job ${job.id} (${job.name}) started`);
    await this.slaService.runPeriodicCheck();
    this.logger.debug(`SLA queue job ${job.id} done`);
  }
}
