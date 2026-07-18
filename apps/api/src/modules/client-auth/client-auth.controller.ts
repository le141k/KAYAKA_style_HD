import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Ip,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ZodValidationPipe } from '../../common/zod-validation.pipe';
import { Public } from '../../auth/auth.decorators';
import { ClientPortalGuard } from '../../auth/client-portal.guard';
import { AppConfig, APP_CONFIG } from '../../config/configuration';
import { AbuseQuotaService } from '../../security/abuse-quota.service';
import { TurnstileService } from '../../security/turnstile.service';
import { ClientAuthService, type ClientPrincipal } from './client-auth.service';
import {
  DEV_CLIENT_SESSION_COOKIE,
  LEGACY_PROD_CLIENT_SESSION_COOKIE,
  PROD_CLIENT_SESSION_COOKIE,
  clientSessionCookieName,
} from './client-auth.cookies';
import { ClientAuthenticated, CurrentClient } from './client-auth.decorators';
import { RequestLinkSchema, VerifyClientSchema, type RequestLinkDto, type VerifyClientDto } from './dto';

@ApiTags('client-auth')
@Controller('client-auth')
// S2-1: the ENTIRE client-auth surface (request-link/verify included) is fail-closed 404 in
// production until TELECOM_HD_CLIENT_PORTAL_ENABLED is set — not just the ticket/upload routes.
@UseGuards(ClientPortalGuard)
export class ClientAuthController {
  constructor(
    private readonly clientAuth: ClientAuthService,
    private readonly turnstile: TurnstileService,
    private readonly abuseQuota: AbuseQuotaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private setSessionCookie(res: Response, token: string, expiresAt: Date): void {
    res.cookie(clientSessionCookieName(this.config), token, {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/', // required by the __Host- prefix; host-only (no Domain)
      expires: expiresAt,
    });
  }

  private clearSessionCookie(res: Response): void {
    const options = {
      httpOnly: true,
      secure: this.config.NODE_ENV === 'production',
      sameSite: 'lax' as const,
    };
    for (const name of [
      DEV_CLIENT_SESSION_COOKIE,
      LEGACY_PROD_CLIENT_SESSION_COOKIE,
      PROD_CLIENT_SESSION_COOKIE,
    ]) {
      res.clearCookie(name, { ...options, path: '/api' });
      res.clearCookie(name, { ...options, path: '/' });
    }
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
  async requestLink(@Body(new ZodValidationPipe(RequestLinkSchema)) dto: RequestLinkDto, @Ip() ip: string) {
    await this.turnstile.verify(dto.challengeToken, 'request-link', ip);
    await this.abuseQuota.consume({
      action: 'request-link',
      ip,
      identity: dto.email,
      windowSeconds: 600,
      globalLimit: 300,
      ipLimit: 10,
      identityLimit: 5,
    });
    this.clientAuth.queueRequestLink(dto.email);
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
      if (part.slice(0, eq).trim() === clientSessionCookieName(this.config)) {
        return decodeURIComponent(part.slice(eq + 1).trim()) || undefined;
      }
    }
    return undefined;
  }
}
