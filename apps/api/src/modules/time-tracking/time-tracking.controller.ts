import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { TimeTrackingService } from './time-tracking.service';
import { RequirePermissions, CurrentStaff } from '../../auth/auth.decorators';
import type { AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { LogTimeSchema, type LogTimeDto } from './dto';

@ApiTags('time-tracking')
@Controller()
export class TimeTrackingController {
  constructor(private readonly timeTracking: TimeTrackingService) {}

  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @Post('tickets/:id/time')
  @ApiOperation({ summary: 'Log time spent on a ticket by the current staff' })
  logTime(
    @Param('id', ParseIntPipe) ticketId: number,
    @Body(new ZodValidationPipe(LogTimeSchema)) dto: LogTimeDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.timeTracking.create(ticketId, staff.staffId, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @Get('tickets/:id/time')
  @ApiOperation({ summary: 'List time entries for a ticket with the total minutes' })
  listTime(@Param('id', ParseIntPipe) ticketId: number) {
    return this.timeTracking.list(ticketId);
  }

  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @Delete('time/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a time entry (owner only)' })
  deleteTime(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: AuthStaff) {
    return this.timeTracking.remove(id, staff.staffId);
  }
}
