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
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';
import { RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateOrganizationSchema,
  UpdateOrganizationSchema,
  ListOrganizationsQuerySchema,
  type CreateOrganizationDto,
  type UpdateOrganizationDto,
  type ListOrganizationsQueryDto,
} from './dto';

@ApiTags('organizations')
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgsService: OrganizationsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @ApiOperation({ summary: 'List organizations' })
  list(@Query(new ZodValidationPipe(ListOrganizationsQuerySchema)) query: ListOrganizationsQueryDto) {
    return this.orgsService.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @ApiOperation({ summary: 'Get an organization by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.orgsService.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @UsePipes(new ZodValidationPipe(CreateOrganizationSchema))
  @ApiOperation({ summary: 'Create an organization' })
  create(@Body() dto: CreateOrganizationDto) {
    return this.orgsService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @ApiOperation({ summary: 'Update an organization' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateOrganizationSchema)) dto: UpdateOrganizationDto,
  ) {
    return this.orgsService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ORG_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an organization' })
  delete(@Param('id', ParseIntPipe) id: number) {
    return this.orgsService.delete(id);
  }
}
