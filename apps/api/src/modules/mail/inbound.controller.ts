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
} from '@nestjs/common';
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
   * Example pipe script:
   *   #!/bin/sh
   *   RAW=$(cat); exec curl -fsS -X POST "$API/api/inbound/pipe" \
   *     -H "x-inbound-secret: $SECRET" -H 'content-type: application/json' \
   *     --data "$(jq -Rs '{raw: .}' <<EOF
   *   $RAW
   *   EOF
   *   )"
   */
  @Public()
  @Post('pipe')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest a raw RFC822 message (MTA/PIPE; shared-secret auth, not JWT)' })
  async pipe(
    @Headers('x-inbound-secret') secret: string | undefined,
    @Headers('x-inbound-delivery-id') deliveryId: string | undefined,
    @Body() body: InboundPipeBody | Buffer,
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

    // Accept EITHER raw bytes (Content-Type: message/rfc822 or application/octet-stream —
    // byte-exact, preferred for real mail + attachments) OR a JSON `{ raw }` body.
    let raw: Buffer | string | undefined;
    if (Buffer.isBuffer(body)) {
      raw = body;
    } else if (body && typeof (body as InboundPipeBody).raw === 'string') {
      raw = (body as InboundPipeBody).raw;
    }
    if (raw == null || (Buffer.isBuffer(raw) ? raw.length === 0 : raw.trim().length === 0)) {
      throw new BadRequestException('Missing message body (raw RFC822 bytes or JSON { raw })');
    }

    // Department is resolved downstream (parser rules / default); the webhook is a
    // single ingress so it does not carry a per-queue department. An optional
    // `x-inbound-delivery-id` header gives the MTA an explicit idempotency key (else
    // the ledger de-dups by content hash).
    const externalId = deliveryId && deliveryId.trim().length > 0 ? deliveryId.trim() : undefined;
    await this.inbound.ingestRawMessage(raw, undefined, externalId);
    return { accepted: true };
  }
}
