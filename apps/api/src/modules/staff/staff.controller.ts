import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StaffService } from './staff.service';
import { RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateStaffSchema,
  UpdateStaffSchema,
  CreateStaffGroupSchema,
  UpdateStaffGroupSchema,
  ListStaffQuerySchema,
  type CreateStaffDto,
  type UpdateStaffDto,
  type CreateStaffGroupDto,
  type UpdateStaffGroupDto,
  type ListStaffQueryDto,
} from './dto';

@ApiTags('staff')
@Controller('staff')
export class StaffController {
  constructor(private readonly staffService: StaffService) {}

  // ─────────────────── Groups ───────────────────

  @Get('groups')
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @ApiOperation({ summary: 'List all staff groups' })
  listGroups() {
    return this.staffService.listGroups();
  }

  @Get('groups/:id')
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @ApiOperation({ summary: 'Get a staff group by ID' })
  getGroup(@Param('id', ParseIntPipe) id: number) {
    return this.staffService.getGroup(id);
  }

  @Post('groups')
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @UsePipes(new ZodValidationPipe(CreateStaffGroupSchema))
  @ApiOperation({ summary: 'Create a staff group' })
  createGroup(@Body() dto: CreateStaffGroupDto) {
    return this.staffService.createGroup(dto);
  }

  @Patch('groups/:id')
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @ApiOperation({ summary: 'Update a staff group' })
  updateGroup(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateStaffGroupSchema)) dto: UpdateStaffGroupDto,
  ) {
    return this.staffService.updateGroup(id, dto);
  }

  // ─────────────────── Members ───────────────────

  @Get()
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @ApiOperation({ summary: 'List staff members' })
  list(@Query(new ZodValidationPipe(ListStaffQuerySchema)) query: ListStaffQueryDto) {
    return this.staffService.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @ApiOperation({ summary: 'Get a staff member by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.staffService.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @UsePipes(new ZodValidationPipe(CreateStaffSchema))
  @ApiOperation({ summary: 'Create a staff member' })
  create(@Body() dto: CreateStaffDto) {
    return this.staffService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @ApiOperation({ summary: 'Update a staff member' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateStaffSchema)) dto: UpdateStaffDto,
  ) {
    return this.staffService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.STAFF_MANAGE)
  @ApiOperation({ summary: 'Disable a staff member (soft delete)' })
  disable(@Param('id', ParseIntPipe) id: number) {
    return this.staffService.disable(id);
  }
}
