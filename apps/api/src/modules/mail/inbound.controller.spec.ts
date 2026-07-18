import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { InboundController } from './inbound.controller';
import type { InboundMailService } from './inbound.service';
import type { AppConfig } from '../../config/configuration';
import type { Request } from 'express';

const SECRET = 'inbound-webhook-secret-32chars-min!!';

function makeController() {
  const inbound = { ingestRawMessage: vi.fn().mockResolvedValue(undefined) } as unknown as InboundMailService;
  const config = { TELECOM_HD_INBOUND_WEBHOOK_SECRET: SECRET } as AppConfig;
  return { controller: new InboundController(inbound, config), inbound };
}

const RAW = ['From: a@b.com', 'Subject: Hi', 'Message-ID: <x@b.com>', '', 'Body'].join('\r\n');
const jsonRequest = { is: vi.fn().mockReturnValue(false) } as unknown as Request;

describe('InboundController (A1 webhook)', () => {
  let ctx: ReturnType<typeof makeController>;
  beforeEach(() => {
    ctx = makeController();
  });

  it('rejects a missing/invalid secret with 403', async () => {
    await expect(ctx.controller.pipe(undefined, { raw: RAW }, jsonRequest)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(ctx.controller.pipe('wrong', { raw: RAW }, jsonRequest)).rejects.toThrow(ForbiddenException);
    expect(ctx.inbound.ingestRawMessage).not.toHaveBeenCalled();
  });

  it('rejects an empty raw body with 400', async () => {
    await expect(ctx.controller.pipe(SECRET, { raw: '' }, jsonRequest)).rejects.toThrow(BadRequestException);
    await expect(ctx.controller.pipe(SECRET, {}, jsonRequest)).rejects.toThrow(BadRequestException);
  });

  it('ingests the raw message when the secret matches', async () => {
    const res = await ctx.controller.pipe(SECRET, { raw: RAW }, jsonRequest);
    expect(res).toEqual({ accepted: true });
    expect(ctx.inbound.ingestRawMessage).toHaveBeenCalledWith(RAW, undefined);
  });
});
