import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UsePipes,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginSchema, RefreshSchema, type LoginDto, type RefreshDto } from './dto';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public, CurrentStaff, RequirePermissions } from './auth.decorators';
import type { AuthStaff } from './auth.decorators';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(LoginSchema))
  @ApiOperation({ summary: 'Authenticate with email + password; returns JWT pair' })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(RefreshSchema))
  @ApiOperation({ summary: 'Rotate refresh token; returns new JWT pair' })
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions()
  @ApiOperation({ summary: 'Revoke all refresh tokens for the current staff member' })
  async logout(@CurrentStaff() staff: AuthStaff) {
    await this.authService.logout(staff.staffId);
  }

  @Get('me')
  @RequirePermissions()
  @ApiOperation({ summary: 'Return current authenticated staff principal' })
  me(@CurrentStaff() staff: AuthStaff): AuthStaff {
    return staff;
  }
}
