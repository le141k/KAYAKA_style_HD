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
    await expect(ctx.controller.pipe(SECRET, 'mta-1', { raw: '' }, '1')).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.pipe(SECRET, 'mta-1', {}, '1')).rejects.toThrow(BadRequestException);
  });

  it('requires both a trusted delivery id and a PIPE queue id', async () => {
    await expect(ctx.controller.pipe(SECRET, undefined, { raw: RAW }, '1')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctx.controller.pipe(SECRET, 'mta-1', { raw: RAW }, undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(ctx.inbound.ingestRawMessage).not.toHaveBeenCalled();
  });

  it('ingests a valid delivery only when the secret, delivery id and queue id all match', async () => {
    const res = await ctx.controller.pipe(SECRET, 'mta-1', { raw: RAW }, '42');
    expect(res).toEqual({ accepted: true });
    expect(ctx.inbound.ingestRawMessage).toHaveBeenCalledWith(RAW, undefined, 'mta-1', 42);
  });

  it('passes an explicit x-inbound-delivery-id through as the idempotency key', async () => {
    await ctx.controller.pipe(SECRET, '  mta-42  ', { raw: RAW }, '7');
    expect(ctx.inbound.ingestRawMessage).toHaveBeenCalledWith(RAW, undefined, 'mta-42', 7);
  });

  it('#8: accepts a raw Buffer body (message/rfc822) byte-for-byte', async () => {
    const buf = Buffer.from(RAW, 'utf8');
    const res = await ctx.controller.pipe(SECRET, 'mta-buffer', buf, '7');
    expect(res).toEqual({ accepted: true });
    expect(ctx.inbound.ingestRawMessage).toHaveBeenCalledWith(buf, undefined, 'mta-buffer', 7);
  });

  it('#8: rejects an empty raw Buffer body with 400', async () => {
    await expect(ctx.controller.pipe(SECRET, 'mta-empty', Buffer.alloc(0), '7')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects an oversized or unsafe delivery id before calling the service', async () => {
    await expect(ctx.controller.pipe(SECRET, 'x'.repeat(257), { raw: RAW }, '7')).rejects.toThrow(
      BadRequestException,
    );
    await expect(ctx.controller.pipe(SECRET, 'mta bad id', { raw: RAW }, '7')).rejects.toThrow(
      BadRequestException,
    );
    expect(ctx.inbound.ingestRawMessage).not.toHaveBeenCalled();
  });
});
