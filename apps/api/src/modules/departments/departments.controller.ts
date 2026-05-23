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
  UsePipes,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { DepartmentsService } from './departments.service';
import { Public, RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateDepartmentSchema,
  UpdateDepartmentSchema,
  type CreateDepartmentDto,
  type UpdateDepartmentDto,
} from './dto';

@ApiTags('departments')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departmentsService: DepartmentsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'List all departments (flat)' })
  list() {
    return this.departmentsService.list();
  }

  @Get('tree')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'Return department tree (nested children)' })
  listTree() {
    return this.departmentsService.listTree();
  }

  // NOTE: must be declared before `@Get(':id')` so 'public' isn't captured as an id param.
  @Get('public')
  @Public()
  @ApiOperation({ summary: 'Public department list (id + title only) for the client submit form' })
  listPublic() {
    return this.departmentsService.listPublic();
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  @ApiOperation({ summary: 'Get a department by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.departmentsService.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_DEPARTMENTS)
  @UsePipes(new ZodValidationPipe(CreateDepartmentSchema))
  @ApiOperation({ summary: 'Create a department' })
  create(@Body() dto: CreateDepartmentDto) {
    return this.departmentsService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_DEPARTMENTS)
  @ApiOperation({ summary: 'Update a department' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateDepartmentSchema)) dto: UpdateDepartmentDto,
  ) {
    return this.departmentsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_DEPARTMENTS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a department' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.departmentsService.delete(id);
  }
}
