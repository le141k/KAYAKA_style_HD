import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InboundController } from './inbound.controller';
import type { InboundMailService } from './inbound.service';
import type { AppConfig } from '../../config/configuration';

const SECRET = 'inbound-webhook-secret-32chars-min!!';

function makeController() {
  const inbound = { ingestRawMessage: vi.fn().mockResolvedValue(undefined) } as unknown as InboundMailService;
  const config = { TELECOM_HD_INBOUND_WEBHOOK_SECRET: SECRET } as AppConfig;
  return { controller: new InboundController(inbound, config), inbound };
}

const RAW = ['From: a@b.com', 'Subject: Hi', 'Message-ID: <x@b.com>', '', 'Body'].join('\r\n');

describe('InboundController (A1 webhook)', () => {
  let ctx: ReturnType<typeof makeController>;
  beforeEach(() => {
    ctx = makeController();
  });

  it('rejects a missing/invalid secret with 403', async () => {
    await expect(ctx.controller.pipe(undefined, undefined, { raw: RAW })).rejects.toThrow(ForbiddenException);
    await expect(ctx.controller.pipe('wrong', undefined, { raw: RAW })).rejects.toThrow(ForbiddenException);
    expect(ctx.inbound.ingestRawMessage).not.toHaveBeenCalled();
  });

  it('rejects an empty raw body with 400', async () => {
    await expect(ctx.controller.pipe(SECRET, undefined, { raw: '' })).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.pipe(SECRET, undefined, {})).rejects.toThrow(BadRequestException);
  });

  it('ingests the raw message when the secret matches (no delivery id → content-hash idempotency)', async () => {
    const res = await ctx.controller.pipe(SECRET, undefined, { raw: RAW });
    expect(res).toEqual({ accepted: true });
    expect(ctx.inbound.ingestRawMessage).toHaveBeenCalledWith(RAW, undefined, undefined);
  });

  it('passes an explicit x-inbound-delivery-id through as the idempotency key', async () => {
    await ctx.controller.pipe(SECRET, '  mta-42  ', { raw: RAW });
    expect(ctx.inbound.ingestRawMessage).toHaveBeenCalledWith(RAW, undefined, 'mta-42');
  });

  it('#8: accepts a raw Buffer body (message/rfc822) byte-for-byte', async () => {
    const buf = Buffer.from(RAW, 'utf8');
    const res = await ctx.controller.pipe(SECRET, undefined, buf);
    expect(res).toEqual({ accepted: true });
    expect(ctx.inbound.ingestRawMessage).toHaveBeenCalledWith(buf, undefined, undefined);
  });

  it('#8: rejects an empty raw Buffer body with 400', async () => {
    await expect(ctx.controller.pipe(SECRET, undefined, Buffer.alloc(0))).rejects.toThrow(
      BadRequestException,
    );
  });
});
