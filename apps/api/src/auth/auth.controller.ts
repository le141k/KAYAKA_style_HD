import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import {
  LoginSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  type LoginDto,
  type ForgotPasswordDto,
  type ResetPasswordDto,
} from './dto';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { Public, CurrentStaff, RequirePermissions } from './auth.decorators';
import type { AuthStaff } from './auth.decorators';
import { AppConfig, APP_CONFIG } from '../config/configuration';
import {
  ACCESS_COOKIE_PATH,
  authCookieNames,
  clearBrowserAuthCookies,
  DEV_REFRESH_TOKEN_COOKIE,
  readCookie,
  REFRESH_COOKIE_PATH,
} from './auth.cookies';
import { CsrfService } from './csrf.service';
import { PasswordResetThrottleService } from './password-reset-throttle.service';

/** Backward-compatible export for tests/importers; production uses `__Host-th_refresh`. */
export const REFRESH_TOKEN_COOKIE = DEV_REFRESH_TOKEN_COOKIE;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly csrf: CsrfService,
    private readonly passwordResetThrottle: PasswordResetThrottleService,
  ) {}

  /**
   * Set host-only HttpOnly auth cookies. Raw JWTs never enter the browser JSON
   * response; the readable CSRF cookie contains only a signed random nonce.
   */
  private setAuthCookies(res: Response, accessToken: string, refreshToken?: string): void {
    const secure = this.config.NODE_ENV === 'production';
    const names = authCookieNames(this.config);
    // SameSite=Lax lets the cookie ride top-level navigations (server middleware
    // guard) while still blocking cross-site POST CSRF for the bulk of cases.
    res.cookie(names.access, accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      path: ACCESS_COOKIE_PATH,
      maxAge: this.config.TELECOM_HD_JWT_ACCESS_TTL * 1000,
    });
    if (refreshToken) {
      res.cookie(names.refresh, refreshToken, {
        httpOnly: true,
        secure,
        sameSite: 'lax',
        path: REFRESH_COOKIE_PATH,
        maxAge: this.config.TELECOM_HD_JWT_REFRESH_TTL * 1000,
      });
    }
    this.csrf.issue(res);
  }

  private clearAuthCookies(res: Response): void {
    clearBrowserAuthCookies(res, this.config);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UsePipes(new ZodValidationPipe(LoginSchema))
  @ApiOperation({ summary: 'Authenticate with email + password; sets cookies and returns safe staff' })
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.authService.login(dto.email, dto.password, res.req.ip);
    this.setAuthCookies(res, result.accessToken, result.refreshToken);
    return { staff: result.staff };
  }

  /** Mint/rotate the readable signed double-submit token (never an auth credential). */
  @Public()
  @Get('csrf')
  @ApiOperation({ summary: 'Issue a signed CSRF double-submit token' })
  csrfToken(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return { csrfToken: this.csrf.issue(res) };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // E2: rate-limit token rotation too (a stolen/guessed refresh token shouldn't be
  // brute-forceable). Slightly higher than login since legit clients rotate often.
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @ApiOperation({ summary: 'Rotate the cookie-only staff session' })
  async refresh(@Res({ passthrough: true }) res: Response) {
    try {
      const refreshToken = readCookie(res.req.headers.cookie, authCookieNames(this.config).refresh);
      if (!refreshToken) throw new UnauthorizedException('Missing refresh cookie');
      const tokens = await this.authService.refresh(refreshToken);
      this.setAuthCookies(res, tokens.accessToken, tokens.refreshRotated ? tokens.refreshToken : undefined);
      return { ok: true };
    } catch (err) {
      // A stale/replayed/missing refresh cookie must never survive to trigger a loop.
      this.clearAuthCookies(res);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions()
  @ApiOperation({ summary: 'Revoke all refresh tokens for the current staff member' })
  async logout(@CurrentStaff() staff: AuthStaff, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(staff.staffId, staff.jti, staff.exp);
    this.clearAuthCookies(res);
  }

  @Get('me')
  @RequirePermissions()
  @ApiOperation({ summary: 'Return current authenticated staff principal' })
  me(@CurrentStaff() staff: AuthStaff): Omit<AuthStaff, 'jti' | 'exp'> {
    // E2: don't expose the JWT id / expiry to the client — they're internal token
    // bookkeeping (used by logout), not part of the staff principal.
    const { jti: _jti, exp: _exp, ...principal } = staff;
    void _jti;
    void _exp;
    return principal;
  }

  // ─────────────────── Password reset ───────────────────

  /**
   * Initiate a password reset.  Always returns 200 to prevent email enumeration.
   * Rate-limited to 3 requests per 60 s per IP to prevent abuse.
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({ summary: 'Request a password-reset link (always 200, no enumeration)' })
  async forgotPassword(
    @Body(new ZodValidationPipe(ForgotPasswordSchema)) dto: ForgotPasswordDto,
    @Req() req: Request,
  ) {
    // The quota decision is synchronous and cluster-wide. Account lookup + SMTP
    // continue off the response path so an attacker cannot distinguish a known
    // address from an unknown one using response latency.
    await this.passwordResetThrottle.consume(dto.email, req.ip);
    this.authService.queuePasswordReset(dto.email);
    return { message: 'If that email is registered, a reset link has been sent.' };
  }

  /**
   * Consume a password-reset token and set a new password.
   * Returns 200 on success; 400 if the token is invalid, expired, or already used.
   */
  @Public()
  @Post('reset-password')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a new password using a reset token' })
  async resetPassword(@Body(new ZodValidationPipe(ResetPasswordSchema)) dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.password);
    return { message: 'Password has been reset successfully.' };
  }
}
