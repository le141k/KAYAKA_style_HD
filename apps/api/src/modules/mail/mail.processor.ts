import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MailService } from './mail.service';
import type { SendMailOptions } from './mail.service';

export type SendMailJobData = SendMailOptions;

/**
 * BullMQ processor for the 'mail' queue.
 * Moves outbound email sending off the critical path.
 */
@Processor('mail')
export class MailProcessor extends WorkerHost {
  private readonly logger = new Logger(MailProcessor.name);

  constructor(private readonly mailService: MailService) {
    super();
  }

  async process(job: Job<SendMailJobData>): Promise<void> {
    this.logger.debug(`Mail job ${job.id}: delivery started`);
    // deliver() = actual SMTP. Must NOT call send() here (that would re-enqueue).
    // Pass throwOnError so a failed send rethrows → BullMQ retries (attempts:3).
    await this.mailService.deliver(job.data, true);
    this.logger.debug(`Mail job ${job.id}: done`);
  }
}
