import { Module } from '@nestjs/common';
import { TimeTrackingController } from './time-tracking.controller';
import { TimeTrackingService } from './time-tracking.service';
import { TicketAccessModule } from '../tickets/ticket-access.module';

/** Time tracking domain: log/list/delete time spent by staff on tickets. */
@Module({
  imports: [TicketAccessModule],
  controllers: [TimeTrackingController],
  providers: [TimeTrackingService],
  exports: [TimeTrackingService],
})
export class TimeTrackingModule {}
