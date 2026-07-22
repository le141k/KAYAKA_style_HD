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
import { inboundSecretMatches } from '../../common/inbound-secret.util';
import { normalizePipeDeliveryId, parsePipeQueueId } from './pipe-input.util';

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
   * Example pipe wrapper (the MTA supplies its stable delivery id as $1):
   *   #!/bin/sh
   *   exec curl --fail-with-body --silent --show-error -X POST "$API/api/inbound/pipe" \
   *     -H "x-inbound-secret: ${INBOUND_SECRET:?}" \
   *     -H "x-inbound-delivery-id: $1" \
   *     -H "x-inbound-queue-id: ${PIPE_QUEUE_ID:?}" \
   *     -H 'content-type: message/rfc822' --data-binary @-
   * Do not capture mail in a shell variable or JSON-encode it: that changes bytes and can
   * corrupt attachments. `--data-binary @-` streams the original RFC822 payload unchanged.
   */
  @Public()
  @Post('pipe')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest a raw RFC822 message (MTA/PIPE; shared-secret auth, not JWT)' })
  async pipe(
    @Headers('x-inbound-secret') secret: string | undefined,
    @Headers('x-inbound-delivery-id') deliveryId: string | undefined,
    @Body() body: InboundPipeBody | Buffer,
    @Headers('x-inbound-queue-id') queueId?: string,
  ) {
    const expected = this.config.TELECOM_HD_INBOUND_WEBHOOK_SECRET;
    if (!inboundSecretMatches(secret, expected)) {
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

    // A PIPE request has no safe implicit identity or routing fallback. The trusted MTA
    // supplies both a bounded delivery id and an enabled PIPE queue id; content hashes are
    // forensic data only and never collapse two independent deliveries.
    const externalId = normalizePipeDeliveryId(deliveryId);
    const boundQueueId = parsePipeQueueId(queueId);
    await this.inbound.ingestRawMessage(raw, undefined, externalId, boundQueueId);
    return { accepted: true };
  }
}
