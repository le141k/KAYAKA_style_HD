import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FollowUpsService } from './follow-ups.service';
import { RequirePermissions, CurrentStaff } from '../../auth/auth.decorators';
import type { AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateFollowUpSchema,
  ToggleFollowUpSchema,
  type CreateFollowUpDto,
  type ToggleFollowUpDto,
} from './dto';

@ApiTags('follow-ups')
@Controller()
export class FollowUpsController {
  constructor(private readonly followUpsService: FollowUpsService) {}

  @Post('tickets/:id/follow-ups')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'Schedule a follow-up reminder on a ticket' })
  create(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(CreateFollowUpSchema)) dto: CreateFollowUpDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    return this.followUpsService.create(id, staff.staffId, dto);
  }

  @Get('tickets/:id/follow-ups')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'List follow-ups for a ticket (ordered by due date)' })
  list(@Param('id', ParseIntPipe) id: number) {
    return this.followUpsService.listForTicket(id);
  }

  @Patch('follow-ups/:id')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'Mark a follow-up complete or incomplete' })
  toggle(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(ToggleFollowUpSchema)) dto: ToggleFollowUpDto,
    @CurrentStaff() staff: AuthStaff,
  ) {
    const canManageOthers = staff.isAdmin || staff.permissions.includes(PERMISSIONS.STAFF_MANAGE);
    return this.followUpsService.setCompleted(id, dto.completed, staff.staffId, canManageOthers);
  }

  @Delete('follow-ups/:id')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'Delete a follow-up (owner, or admin/STAFF_MANAGE)' })
  remove(@Param('id', ParseIntPipe) id: number, @CurrentStaff() staff: AuthStaff) {
    const canManageOthers = staff.isAdmin || staff.permissions.includes(PERMISSIONS.STAFF_MANAGE);
    return this.followUpsService.remove(id, staff.staffId, canManageOthers);
  }
}
