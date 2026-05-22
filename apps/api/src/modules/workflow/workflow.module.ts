import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
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
export class WorkflowModule {}
