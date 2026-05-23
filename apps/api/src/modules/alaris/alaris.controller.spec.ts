import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AlarisController } from './alaris.controller';
import type { AlarisService, AlarisWebhookPayload } from './alaris.service';
import type { AppConfig } from '../../config/configuration';

const SECRET = 'test-alaris-secret';

function makeController(
  ingest = vi.fn().mockResolvedValue({ ticketId: 1, mask: 'TT-1', deduplicated: false }),
) {
  const service = { ingest } as unknown as AlarisService;
  const config = { TELECOM_HD_ALARIS_WEBHOOK_SECRET: SECRET } as AppConfig;
  return { controller: new AlarisController(service, config), ingest };
}

const validPayload: AlarisWebhookPayload = {
  externalId: 'evt-1',
  message: 'Trunk down',
} as AlarisWebhookPayload;

describe('AlarisController.webhook', () => {
  let ctrl: AlarisController;
  let ingest: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    ({ controller: ctrl, ingest } = makeController());
  });

  it('rejects a wrong/missing secret with 403', async () => {
    await expect(ctrl.webhook('nope', validPayload)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(ctrl.webhook(undefined, validPayload)).rejects.toBeInstanceOf(ForbiddenException);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('returns 400 (BadRequestException) when externalId or message is missing', async () => {
    await expect(ctrl.webhook(SECRET, { message: 'x' } as AlarisWebhookPayload)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(ctrl.webhook(SECRET, { externalId: 'e' } as AlarisWebhookPayload)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(ingest).not.toHaveBeenCalled();
  });

  it('ingests a valid event with the correct secret', async () => {
    const res = await ctrl.webhook(SECRET, validPayload);
    expect(ingest).toHaveBeenCalledWith(validPayload);
    expect(res).toEqual(expect.objectContaining({ mask: 'TT-1' }));
  });
});
