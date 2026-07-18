import { timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InboundMailService } from './inbound.service';
import { Public } from '../../auth/auth.decorators';
import { AppConfig, APP_CONFIG } from '../../config/configuration';

/** Body shape for the inbound pipe webhook. */
interface InboundPipeBody {
  /** The full raw RFC822 message (headers + body). */
  raw?: string;
}

@ApiTags('inbound')
@Controller('inbound')
export class InboundController {
  constructor(
    private readonly inbound: InboundMailService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * A1 — inbound mail webhook for the MTA/PIPE delivery case (e.g. a Postfix/Exim
   * pipe transport or an aliases `|` command that POSTs the raw message here).
   * Not JWT-protected; guarded by a shared-secret header compared in constant time.
   * Feeds the exact same parse→thread→ticket pipeline as the IMAP poller.
   *
   * Example pipe script (stdin is streamed; it is never expanded into argv/env):
   *   #!/bin/sh
   *   exec curl -fsS -X POST "$API/api/inbound/pipe" \
   *     -H "x-inbound-secret: $SECRET" -H 'content-type: message/rfc822' \
   *     --data-binary @-
   */
  @Public()
  @Post('pipe')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest a raw RFC822 message (MTA/PIPE; shared-secret auth, not JWT)' })
  async pipe(
    @Headers('x-inbound-secret') secret: string | undefined,
    @Body() body: InboundPipeBody | undefined,
    @Req() request: Request,
  ) {
    const expected = this.config.TELECOM_HD_INBOUND_WEBHOOK_SECRET;
    let secretOk = false;
    if (secret) {
      const provided = Buffer.from(secret, 'utf8');
      const expectedBuf = Buffer.from(expected, 'utf8');
      secretOk = provided.byteLength === expectedBuf.byteLength && timingSafeEqual(provided, expectedBuf);
    }
    if (!secretOk) {
      throw new ForbiddenException('Invalid inbound webhook secret');
    }

    const legacyJson = typeof body?.raw === 'string' ? body.raw : undefined;
    const isRawRfc822 = Boolean(request.is('message/rfc822') || request.is('application/octet-stream'));
    if (!legacyJson && !isRawRfc822) {
      throw new BadRequestException(
        'Send the RFC822 message as message/rfc822 (legacy JSON raw is accepted only for small messages)',
      );
    }

    // Department is resolved downstream (parser rules / default); the webhook is a
    // single ingress so it does not carry a per-queue department.
    await this.inbound.ingestRawMessage(legacyJson ?? request, undefined);
    return { accepted: true };
  }
}
