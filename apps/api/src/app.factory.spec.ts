import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { configureInboundPipeMiddleware } from './app.factory';

const SECRET = 'inbound-webhook-secret-32chars-min!!';

function makeApp(maxMb = 1, inboundDeliveryEnabled = true) {
  const app = express();
  configureInboundPipeMiddleware(app, {
    TELECOM_HD_INBOUND_WEBHOOK_SECRET: SECRET,
    TELECOM_HD_INBOUND_MAX_SIZE_MB: maxMb,
    TELECOM_HD_INBOUND_DELIVERY_ENABLED: inboundDeliveryEnabled,
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

  it('keeps message/rfc822 bytes byte-exact as a Buffer after the secret check', async () => {
    const ctx = makeApp();
    const raw = Buffer.from([0x46, 0x72, 0x6f, 0x6d, 0x3a, 0x20, 0xff, 0x00, 0x0d, 0x0a]);
    const response = await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('content-type', 'message/rfc822')
      .set('x-inbound-secret', SECRET)
      .send(raw)
      .expect(200);
    expect(response.body).toEqual({ isBuffer: true, hex: raw.toString('hex'), json: null });
  });

  it('does not let the global JSON parser steal a valid PIPE JSON body', async () => {
    const ctx = makeApp();
    const response = await supertest(ctx.app)
      .post('/api/inbound/pipe')
      .set('x-inbound-secret', SECRET)
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
      .send(Buffer.alloc(1024 * 1024 + 1, 0x61))
      .expect(413);
  });
});
