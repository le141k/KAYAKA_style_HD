import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Res,
  UsePipes,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginSchema, RefreshSchema, type LoginDto, type RefreshDto } from './dto';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public, CurrentStaff, RequirePermissions } from './auth.decorators';
import type { AuthStaff } from './auth.decorators';
import { ACCESS_TOKEN_COOKIE } from './jwt-auth.guard';
import { AppConfig, APP_CONFIG } from '../config/configuration';

/** Name of the HttpOnly refresh-token cookie. */
export const REFRESH_TOKEN_COOKIE = 'th_refresh';

/** Read a single cookie value from a raw Cookie header (no cookie-parser needed). */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
    }
  }
  return undefined;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Set HttpOnly auth cookies on the response. This is ADDITIVE: we still return
   * the tokens in the JSON body, so existing localStorage/Bearer clients keep
   * working unchanged. New clients rely on the HttpOnly cookies (immune to XSS).
   */
  private setAuthCookies(res: Response, accessToken: string, refreshToken?: string): void {
    const secure = this.config.NODE_ENV === 'production';
    // SameSite=Lax lets the cookie ride top-level navigations (server middleware
    // guard) while still blocking cross-site POST CSRF for the bulk of cases.
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: '/',
      maxAge: this.config.TELECOM_HD_JWT_ACCESS_TTL * 1000,
    });
    if (refreshToken) {
      res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: '/',
        maxAge: this.config.TELECOM_HD_JWT_REFRESH_TTL * 1000,
      });
    }
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UsePipes(new ZodValidationPipe(LoginSchema))
  @ApiOperation({ summary: 'Authenticate with email + password; returns JWT pair' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto.email, dto.password);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return result;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token; returns new JWT pair' })
  async refresh(@Body() body: Partial<RefreshDto>, @Res({ passthrough: true }) res: Response) {
    // Accept the refresh token from the request body (legacy localStorage client)
    // OR from the HttpOnly th_refresh cookie (new cookie-based client). The cookie
    // is read straight from the raw header so we need no cookie-parser middleware.
    const fromCookie = readCookie(res.req.headers.cookie, REFRESH_TOKEN_COOKIE);
    const parsed = RefreshSchema.safeParse({ refreshToken: body?.refreshToken ?? fromCookie });
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'Validation failed',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    const tokens = await this.authService.refresh(parsed.data.refreshToken);
    this.setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return tokens;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions()
  @ApiOperation({ summary: 'Revoke all refresh tokens for the current staff member' })
  async logout(@CurrentStaff() staff: AuthStaff, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(staff.staffId);
    this.clearAuthCookies(res);
  }

  @Get('me')
  @RequirePermissions()
  @ApiOperation({ summary: 'Return current authenticated staff principal' })
  me(@CurrentStaff() staff: AuthStaff): AuthStaff {
    return staff;
  }
}
