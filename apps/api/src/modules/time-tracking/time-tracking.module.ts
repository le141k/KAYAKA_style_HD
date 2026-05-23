import { Module } from '@nestjs/common';
import { TimeTrackingController } from './time-tracking.controller';
import { TimeTrackingService } from './time-tracking.service';

/** Time tracking domain: log/list/delete time spent by staff on tickets. */
@Module({
  controllers: [TimeTrackingController],
  providers: [TimeTrackingService],
  exports: [TimeTrackingService],
})
export class TimeTrackingModule {}
