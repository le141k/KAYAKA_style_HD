import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AlarisService, type AlarisWebhookPayload } from './alaris.service';
import { Public } from '../../auth/auth.decorators';
import { AppConfig, APP_CONFIG } from '../../config/configuration';

@ApiTags('alaris')
@Controller('alaris')
export class AlarisController {
  constructor(
    private readonly alarisService: AlarisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Webhook endpoint for Alaris monitoring events.
   * Not JWT-protected; instead guarded by a shared-secret header.
   * The secret is compared with TELECOM_HD_ALARIS_WEBHOOK_SECRET.
   */
  @Public()
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Receive Alaris monitoring event (shared-secret auth, not JWT)',
  })
  async webhook(
    @Headers('x-alaris-secret') secret: string | undefined,
    @Body() payload: AlarisWebhookPayload,
  ) {
    const expected = this.config.TELECOM_HD_ALARIS_WEBHOOK_SECRET;
    const secretOk =
      !!secret &&
      secret.length === expected.length &&
      timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
    if (!secretOk) {
      throw new ForbiddenException('Invalid Alaris webhook secret');
    }

    if (!payload.externalId || !payload.message) {
      throw new Error('Missing required fields: externalId, message');
    }

    return this.alarisService.ingest(payload);
  }
}
