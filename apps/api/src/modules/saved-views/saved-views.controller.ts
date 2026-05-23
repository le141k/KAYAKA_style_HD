import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { CurrentStaff, RequirePermissions, type AuthStaff } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { SavedViewsService } from './saved-views.service';
import { CreateSavedViewSchema, type CreateSavedViewDto } from './dto';

@ApiTags('saved-views')
@Controller('saved-views')
export class SavedViewsController {
  constructor(private readonly savedViews: SavedViewsService) {}

  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @Get()
  @ApiOperation({ summary: 'List the current staff member’s saved ticket-list views' })
  list(@CurrentStaff() staff: AuthStaff) {
    return this.savedViews.list(staff.staffId);
  }

  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @Post()
  @ApiOperation({ summary: 'Create a saved ticket-list view for the current staff member' })
  create(
    @CurrentStaff() staff: AuthStaff,
    @Body(new ZodValidationPipe(CreateSavedViewSchema)) dto: CreateSavedViewDto,
  ) {
    return this.savedViews.create(staff.staffId, dto);
  }

  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete one of the current staff member’s saved views' })
  delete(@CurrentStaff() staff: AuthStaff, @Param('id', ParseIntPipe) id: number) {
    return this.savedViews.delete(staff.staffId, id);
  }
}
