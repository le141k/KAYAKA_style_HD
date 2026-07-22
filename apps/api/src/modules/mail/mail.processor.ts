import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MailService } from './mail.service';
import type { OutboundEmailJobData, SendMailOptions } from './mail.service';

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

  async process(job: Job<SendMailJobData | OutboundEmailJobData>): Promise<void> {
    this.logger.debug(`Mail job ${job.id}: delivery started`);
    if (job.name === 'outbound') {
      const data = job.data as OutboundEmailJobData;
      await this.mailService.processOutboundEmail(data.outboundEmailId);
      this.logger.debug(`Durable outbound mail job ${job.id}: done`);
      return;
    }
    // deliver() = actual SMTP. Must NOT call send() here (that would re-enqueue).
    // Pass throwOnError so a failed send rethrows → BullMQ retries (attempts:3).
    await this.mailService.deliver(job.data as SendMailOptions, true);
    this.logger.debug(`Mail job ${job.id}: done`);
  }
}
