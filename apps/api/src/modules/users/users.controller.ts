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
  Put,
  Query,
  UsePipes,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import {
  CreateUserSchema,
  UpdateUserSchema,
  ListUsersQuerySchema,
  AddEmailSchema,
  type CreateUserDto,
  type UpdateUserDto,
  type ListUsersQueryDto,
  type AddEmailDto,
} from './dto';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'List users with optional search/filter' })
  list(@Query(new ZodValidationPipe(ListUsersQuerySchema)) query: ListUsersQueryDto) {
    return this.usersService.list(query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Get a user by ID' })
  get(@Param('id', ParseIntPipe) id: number) {
    return this.usersService.get(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @UsePipes(new ZodValidationPipe(CreateUserSchema))
  @ApiOperation({ summary: 'Create a new user' })
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Update a user' })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(UpdateUserSchema)) dto: UpdateUserDto,
  ) {
    return this.usersService.update(id, dto);
  }

  @Post(':id/emails')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @ApiOperation({ summary: 'Add an email address to a user' })
  addEmail(
    @Param('id', ParseIntPipe) id: number,
    @Body(new ZodValidationPipe(AddEmailSchema)) dto: AddEmailDto,
  ) {
    return this.usersService.addEmail(id, dto);
  }

  @Delete(':id/emails/:emailId')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a non-primary email from a user' })
  removeEmail(
    @Param('id', ParseIntPipe) id: number,
    @Param('emailId', ParseIntPipe) emailId: number,
  ) {
    return this.usersService.removeEmail(id, emailId);
  }

  @Put(':id/emails/:emailId/primary')
  @RequirePermissions(PERMISSIONS.USER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set a user email as primary' })
  setPrimaryEmail(
    @Param('id', ParseIntPipe) id: number,
    @Param('emailId', ParseIntPipe) emailId: number,
  ) {
    return this.usersService.setPrimaryEmail(id, emailId);
  }
}
