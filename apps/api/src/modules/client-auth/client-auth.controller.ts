import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Public } from '../../auth/auth.decorators';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { ClientAuthService, type ClientPrincipal } from './client-auth.service';
import { ClientAuthenticated, CurrentClient, CLIENT_SESSION_COOKIE } from './client-auth.decorators';
import { RequestLinkSchema, VerifyClientSchema, type RequestLinkDto, type VerifyClientDto } from './dto';

@ApiTags('client-auth')
@Controller('client-auth')
export class ClientAuthController {
  constructor(
    private readonly clientAuth: ClientAuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private setSessionCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(CLIENT_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api', // host-only (no Domain); available to the API only
      expires: expiresAt,
    });
  }

  private clearSessionCookie(res: Response): void {
    res.clearCookie(CLIENT_SESSION_COOKIE, { path: '/api' });
  }

  /**
   * Request a login link. Always returns 202 with the same body — never discloses
   * whether the email exists (S2-4). Tightly throttled by IP.
   */
  @Public()
  @Post('request-link')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({ summary: 'Request a client login link (always 202, no enumeration)' })
  async requestLink(@Body(new ZodValidationPipe(RequestLinkSchema)) dto: RequestLinkDto) {
    await this.clientAuth.requestLink(dto.email);
    return { message: 'If that email owns any tickets, a sign-in link has been sent.' };
  }

  /**
   * Consume a single-use login token (posted in the body, delivered via URL fragment)
   * and open a client session, setting the HttpOnly cookie.
   */
  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Verify a login token and open a client session (sets cookie)' })
  async verify(
    @Body(new ZodValidationPipe(VerifyClientSchema)) dto: VerifyClientDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { sessionToken, expiresAt } = await this.clientAuth.verify(dto.token);
    this.setSessionCookie(res, sessionToken, expiresAt);
    return { ok: true, expiresAt };
  }

  /** Revoke the current client session and clear the cookie. */
  @ClientAuthenticated()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the current client session' })
  async logout(@Res({ passthrough: true }) res: Response) {
    const raw = this.readCookie(res.req.headers['cookie']);
    if (raw) await this.clientAuth.logout(raw);
    this.clearSessionCookie(res);
  }

  /** Return the authenticated client principal (used by the UI to confirm sign-in). */
  @ClientAuthenticated()
  @Get('me')
  @ApiOperation({ summary: 'Return the current verified client principal' })
  me(@CurrentClient() client: ClientPrincipal): ClientPrincipal {
    return client;
  }

  private readCookie(header: string | undefined): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === CLIENT_SESSION_COOKIE) {
        return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
      }
    }
    return undefined;
  }
}
