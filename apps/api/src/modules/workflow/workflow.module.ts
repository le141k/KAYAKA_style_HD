import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { WorkflowService } from './workflow.service';
import { WorkflowExecutor } from './workflow.executor';
import { AutoCloseProcessor } from './auto-close.processor';
import { WorkflowController, MacroCategoryController, MacroController } from './workflow.controller';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [BullModule.registerQueue({ name: 'workflow' }), MailModule],
  controllers: [WorkflowController, MacroCategoryController, MacroController],
  providers: [WorkflowService, WorkflowExecutor, AutoCloseProcessor],
  exports: [WorkflowService],
})
export class WorkflowModule implements OnModuleInit {
  private readonly logger = new Logger(WorkflowModule.name);

  constructor(@InjectQueue('workflow') private readonly workflowQueue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.workflowQueue.add(
      'auto-close',
      {},
      {
        jobId: 'workflow-auto-close-repeatable',
        repeat: { every: 24 * 60 * 60 * 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log('Workflow auto-close repeatable job scheduled (every 24h)');
  }
}
