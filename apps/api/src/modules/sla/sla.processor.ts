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
 * lockDuration must exceed the worst-case scan: up to SLA_BREACH_SCAN_CAP (1000)
 * tickets, each with several awaited DB calls + a mail enqueue. 120s was too tight
 * (lock could expire mid-scan → a second worker re-runs and double-fires notify/
 * add_note); 10 min is comfortably above the realistic worst case.
 */
@Processor('sla', { concurrency: 1, lockDuration: 600_000 })
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
