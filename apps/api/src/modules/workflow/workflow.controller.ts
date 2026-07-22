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
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WorkflowService } from './workflow.service';
import { RequireGlobalAdmin, RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  CreateMacroCategorySchema,
  UpdateMacroCategorySchema,
  CreateMacroSchema,
  UpdateMacroSchema,
  type CreateWorkflowDto,
  type UpdateWorkflowDto,
  type CreateMacroCategoryDto,
  type UpdateMacroCategoryDto,
  type CreateMacroDto,
  type UpdateMacroDto,
} from './dto';

// ─────────────────── Workflow ───────────────────

@ApiTags('admin/workflow')
@Controller('admin/workflows')
@RequireGlobalAdmin()
export class WorkflowController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'List all workflows' })
  list() {
    return this.workflowService.listWorkflows();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Get a workflow by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.workflowService.getWorkflow(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Create a workflow' })
  create(@Body(new ZodValidationPipe(CreateWorkflowSchema)) dto: CreateWorkflowDto) {
    return this.workflowService.createWorkflow(dto);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Update a workflow' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateWorkflowSchema)) dto: UpdateWorkflowDto,
  ) {
    return this.workflowService.updateWorkflow(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a workflow' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.workflowService.deleteWorkflow(id);
  }
}

// ─────────────────── MacroCategory ───────────────────

@ApiTags('admin/workflow')
@Controller('admin/macro-categories')
@RequireGlobalAdmin()
export class MacroCategoryController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'List macro categories' })
  list() {
    return this.workflowService.listMacroCategories();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Get a macro category by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.workflowService.getMacroCategory(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Create a macro category' })
  create(@Body(new ZodValidationPipe(CreateMacroCategorySchema)) dto: CreateMacroCategoryDto) {
    return this.workflowService.createMacroCategory(dto);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Update a macro category' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateMacroCategorySchema)) dto: UpdateMacroCategoryDto,
  ) {
    return this.workflowService.updateMacroCategory(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a macro category' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.workflowService.deleteMacroCategory(id);
  }
}

// ─────────────────── Macro ───────────────────

@ApiTags('admin/workflow')
@Controller('admin/macros')
@RequireGlobalAdmin()
export class MacroController {
  constructor(private readonly workflowService: WorkflowService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'List macros (optionally filter by categoryId)' })
  list(@Query('categoryId') categoryId?: string) {
    return this.workflowService.listMacros(categoryId !== undefined ? parseInt(categoryId, 10) : undefined);
  }

  // Lightweight macro list (id + title) for the ticket apply-macro picker —
  // available to anyone who can edit tickets (agents lack ADMIN_WORKFLOW).
  @Get('options')
  @RequirePermissions(PERMISSIONS.TICKET_EDIT)
  @ApiOperation({ summary: 'List macros (id + title) for the apply-macro picker' })
  options() {
    return this.workflowService.listMacroOptions();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Get a macro by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.workflowService.getMacro(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Create a macro' })
  create(@Body(new ZodValidationPipe(CreateMacroSchema)) dto: CreateMacroDto) {
    return this.workflowService.createMacro(dto);
  }

  @Put(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @ApiOperation({ summary: 'Update a macro' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateMacroSchema)) dto: UpdateMacroDto,
  ) {
    return this.workflowService.updateMacro(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_WORKFLOW)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a macro' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.workflowService.deleteMacro(id);
  }
}
