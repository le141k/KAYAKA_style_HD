import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { AdminService } from './admin.service';
import {
  CreateCustomFieldGroupSchema,
  UpdateCustomFieldGroupSchema,
  CreateCustomFieldSchema,
  UpdateCustomFieldSchema,
  CreateEmailTemplateSchema,
  UpdateEmailTemplateSchema,
  type CreateCustomFieldGroupDto,
  type UpdateCustomFieldGroupDto,
  type CreateCustomFieldDto,
  type UpdateCustomFieldDto,
  type CreateEmailTemplateDto,
  type UpdateEmailTemplateDto,
} from './dto';

@ApiTags('admin/custom-fields')
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── Custom field groups ──
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOMFIELDS)
  @Get('custom-field-groups')
  @ApiOperation({ summary: 'List custom field groups with their fields' })
  listGroups() {
    return this.admin.listGroups();
  }

  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOMFIELDS)
  @Post('custom-field-groups')
  createGroup(@Body(new ZodValidationPipe(CreateCustomFieldGroupSchema)) dto: CreateCustomFieldGroupDto) {
    return this.admin.createGroup(dto);
  }

  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOMFIELDS)
  @Patch('custom-field-groups/:id')
  updateGroup(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateCustomFieldGroupSchema)) dto: UpdateCustomFieldGroupDto,
  ) {
    return this.admin.updateGroup(id, dto);
  }

  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOMFIELDS)
  @Delete('custom-field-groups/:id')
  deleteGroup(@Param('id', ParseIntPipe) id: number) {
    return this.admin.deleteGroup(id);
  }

  // ── Custom fields ──
  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOMFIELDS)
  @Post('custom-field-groups/:groupId/fields')
  createField(
    @Param('groupId', ParseIntPipe) groupId: number,
    @Body(new ZodValidationPipe(CreateCustomFieldSchema)) dto: CreateCustomFieldDto,
  ) {
    return this.admin.createField(groupId, dto);
  }

  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOMFIELDS)
  @Patch('custom-fields/:id')
  updateField(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateCustomFieldSchema)) dto: UpdateCustomFieldDto,
  ) {
    return this.admin.updateField(id, dto);
  }

  @RequirePermissions(PERMISSIONS.ADMIN_CUSTOMFIELDS)
  @Delete('custom-fields/:id')
  deleteField(@Param('id', ParseIntPipe) id: number) {
    return this.admin.deleteField(id);
  }

  // ── Email templates ──
  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @Get('email-templates')
  @ApiOperation({ summary: 'List email templates' })
  listTemplates() {
    return this.admin.listTemplates();
  }

  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @Post('email-templates')
  createTemplate(@Body(new ZodValidationPipe(CreateEmailTemplateSchema)) dto: CreateEmailTemplateDto) {
    return this.admin.createTemplate(dto);
  }

  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @Patch('email-templates/:id')
  updateTemplate(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateEmailTemplateSchema)) dto: UpdateEmailTemplateDto,
  ) {
    return this.admin.updateTemplate(id, dto);
  }

  @RequirePermissions(PERMISSIONS.ADMIN_MAIL)
  @Delete('email-templates/:id')
  deleteTemplate(@Param('id', ParseIntPipe) id: number) {
    return this.admin.deleteTemplate(id);
  }
}
