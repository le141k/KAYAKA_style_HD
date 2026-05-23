import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ReferenceService,
  CreateStatusSchema,
  CreatePrioritySchema,
  CreateTypeSchema,
  type CreateStatusDto,
  type CreatePriorityDto,
  type CreateTypeDto,
} from './reference.service';
import { RequirePermissions, Public } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';

@ApiTags('ticket-reference')
@Controller()
export class ReferenceController {
  constructor(private readonly refService: ReferenceService) {}

  // ─── Statuses ───

  @Get('ticket-statuses')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'List ticket statuses' })
  listStatuses() {
    return this.refService.listStatuses();
  }

  @Post('ticket-statuses')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @ApiOperation({ summary: 'Create a ticket status' })
  createStatus(@Body(new ZodValidationPipe(CreateStatusSchema)) dto: CreateStatusDto) {
    return this.refService.createStatus(dto);
  }

  @Patch('ticket-statuses/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @ApiOperation({ summary: 'Update a ticket status' })
  updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(CreateStatusSchema.partial())) dto: Partial<CreateStatusDto>,
  ) {
    return this.refService.updateStatus(id, dto);
  }

  @Delete('ticket-statuses/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a ticket status' })
  deleteStatus(@Param('id', ParseIntPipe) id: number) {
    return this.refService.deleteStatus(id);
  }

  // ─── Priorities ───

  @Get('ticket-priorities')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'List ticket priorities' })
  listPriorities() {
    return this.refService.listPriorities();
  }

  // Public list (id + title) so the unauthenticated client portal can map a
  // chosen priority slug → id dynamically (no hardcoded seed-order assumptions).
  @Public()
  @Get('ticket-priorities/public')
  @ApiOperation({ summary: 'List ticket priorities (public, id + title)' })
  listPrioritiesPublic() {
    return this.refService.listPrioritiesPublic();
  }

  @Post('ticket-priorities')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @ApiOperation({ summary: 'Create a ticket priority' })
  createPriority(@Body(new ZodValidationPipe(CreatePrioritySchema)) dto: CreatePriorityDto) {
    return this.refService.createPriority(dto);
  }

  @Patch('ticket-priorities/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @ApiOperation({ summary: 'Update a ticket priority' })
  updatePriority(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(CreatePrioritySchema.partial())) dto: Partial<CreatePriorityDto>,
  ) {
    return this.refService.updatePriority(id, dto);
  }

  @Delete('ticket-priorities/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a ticket priority' })
  deletePriority(@Param('id', ParseIntPipe) id: number) {
    return this.refService.deletePriority(id);
  }

  // ─── Types ───

  @Get('ticket-types')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'List ticket types' })
  listTypes() {
    return this.refService.listTypes();
  }

  @Post('ticket-types')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @ApiOperation({ summary: 'Create a ticket type' })
  createType(@Body(new ZodValidationPipe(CreateTypeSchema)) dto: CreateTypeDto) {
    return this.refService.createType(dto);
  }

  @Patch('ticket-types/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @ApiOperation({ summary: 'Update a ticket type' })
  updateType(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(CreateTypeSchema.partial())) dto: Partial<CreateTypeDto>,
  ) {
    return this.refService.updateType(id, dto);
  }

  @Delete('ticket-types/:id')
  @RequirePermissions(PERMISSIONS.ADMIN_SETTINGS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a ticket type' })
  deleteType(@Param('id', ParseIntPipe) id: number) {
    return this.refService.deleteType(id);
  }
}
