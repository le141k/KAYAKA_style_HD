import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { configureInboundPipeMiddleware } from './app.factory';

const SECRET = 'inbound-webhook-secret-32chars-min!!';

function makeApp(
  maxMb = 1,
  inboundDeliveryEnabled = true,
  captureOnlyEnabled = false,
  captureQueueId: number | undefined = undefined,
  normalCanaryQueueId: number | undefined = undefined,
  normalCanaryDeliveryId: number | undefined = undefined,
) {
  const app = express();
  configureInboundPipeMiddleware(app, {
    TELECOM_HD_INBOUND_WEBHOOK_SECRET: SECRET,
    TELECOM_HD_INBOUND_MAX_SIZE_MB: maxMb,
    TELECOM_HD_INBOUND_DELIVERY_ENABLED: inboundDeliveryEnabled,
    TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED: captureOnlyEnabled,
    TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID: captureQueueId,
    TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID: normalCanaryQueueId,
    TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID: normalCanaryDeliveryId,
  });
  // Mirror createApiApp: PIPE's route-specific parser must consume JSON before the
  // global parser gets a chance to steal the body.
  app.use(express.json({ limit: '1mb' }));
  let reachedHandler = false;
  app.post('/api/inbound/pipe', (req, res) => {
    reachedHandler = true;
    res.json({
      isBuffer: Buffer.isBuffer(req.body),
      hex: Buffer.isBuffer(req.body) ? req.body.toString('hex') : null,
      json: Buffer.isBuffer(req.body) ? null : req.body,
    });
  });
  return { app, reachedHandler: () => reachedHandler };
}

describe('production inbound PIPE middleware', () => {
  it('rejects an invalid secret before the large body parser/route handler runs', async () => {
    const ctx = makeApp();
    await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-secret', 'wrong')
      .send(Buffer.alloc(32))
      .expect(403);
    expect(ctx.reachedHandler()).toBe(false);
  });

  it('cutover gate rejects a valid-secret PIPE request before body parsing or the route handler', async () => {
    const ctx = makeApp(1, false);
    await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-secret', SECRET)
      // Keep the client write small: a server that intentionally returns 503 before
      // reading an oversized request can close the socket while supertest is writing,
      // producing EPIPE instead of the response we need to assert here.
      .send(Buffer.from('From: sender@example.test\r\n\r\nbody'))
      .expect(503);
    expect(ctx.reachedHandler()).toBe(false);
  });

  it('capture-only rejects every PIPE request before body parsing, including its configured queue id', async () => {
    const ctx = makeApp(1, false, true, 42);
    await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-secret', SECRET)
      .set('x-inbound-delivery-id', 'capture-test')
      .set('x-inbound-queue-id', '42')
      .send(Buffer.from('From: sender@example.test\r\n\r\nbody'))
      .expect(503);
    expect(ctx.reachedHandler()).toBe(false);
  });

  it('promotion-only normal canary rejects PIPE before the MIME parser or route handler', async () => {
    const ctx = makeApp(1, true, false, undefined, 42, 99);
    await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-secret', SECRET)
      .set('x-inbound-delivery-id', 'normal-canary-pipe')
      .set('x-inbound-queue-id', '42')
      .send(Buffer.from('From: sender@example.test\r\n\r\nbody'))
      .expect(503);
    expect(ctx.reachedHandler()).toBe(false);
  });

  it('normal PIPE rejects missing or malformed transport headers before the raw parser allocates the body', async () => {
    for (const unsafeHeader of ['0x2a', '42.0', '4.2e1', '+42', '00042']) {
      const ctx = makeApp();
      await supertest(ctx.app)
        .post('/api/inbound/pipe')
        .set('content-type', 'message/rfc822')
        .set('x-inbound-secret', SECRET)
        .set('x-inbound-delivery-id', 'mta-test')
        .set('x-inbound-queue-id', unsafeHeader)
        .send(Buffer.from('From: sender@example.test\r\n\r\nbody'))
        .expect(400);
      expect(ctx.reachedHandler()).toBe(false);
    }

    const missingId = makeApp();
    await supertest(missingId.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-secret', SECRET)
      .set('x-inbound-queue-id', '42')
      .send(Buffer.from('From: sender@example.test\r\n\r\nbody'))
      .expect(400);
    expect(missingId.reachedHandler()).toBe(false);
  });

  it('keeps message/rfc822 bytes byte-exact as a Buffer after the secret check', async () => {
    const ctx = makeApp();
    const raw = Buffer.from([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x20, 0xff, 0x00, 0x0d, 0x0a]);
    const response = await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-secret', SECRET)
      .set('x-inbound-delivery-id', 'mta-bytes')
      .set('x-inbound-queue-id', '42')
      .send(raw)
      .expect(200);
    expect(response.body).toEqual({ isBuffer: true, hex: raw.toString('hex'), json: null });
  });

  it('does not let the global JSON parser steal a valid PIPE JSON body', async () => {
    const ctx = makeApp();
    const response = await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('x-inbound-secret', SECRET)
      .set('x-inbound-delivery-id', 'mta-json')
      .set('x-inbound-queue-id', '42')
      .send({ raw: 'From: sender@example.test\r\n\r\nBody' })
      .expect(200);
    expect(response.body).toEqual({
      isBuffer: false,
      hex: null,
      json: { raw: 'From: sender@example.test\r\n\r\nBody' },
    });
  });

  it('returns 413 when a valid PIPE payload exceeds the configured bound', async () => {
    const ctx = makeApp(1);
    await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'application/octet-stream')
      .set('x-inbound-secret', SECRET)
      .set('x-inbound-delivery-id', 'mta-too-large')
      .set('x-inbound-queue-id', '42')
      .send(Buffer.alloc(1024 * 1024 + 1, 0x61))
      .expect(413);
  });
});
