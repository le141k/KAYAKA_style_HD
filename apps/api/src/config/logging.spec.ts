import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { buildPinoHttpOptions } from './logging';
import type { AppConfig } from './configuration';

/**
 * GOAL_PUBLIC_SECURITY S1-2 — log-secrecy regression.
 *
 * Drive representative request/response shapes (login, refresh, webhook, reset) with
 * unique sentinel values through the EXACT production logging config and assert none of
 * the sentinels — headers, cookies, bearer tokens, passwords, URL tokens or ?email=
 * lookups — survive into the emitted log stream.
 */

const CONFIG = {
  NODE_ENV: 'test',
  TELECOM_HD_LOG_LEVEL: 'trace',
} as unknown as AppConfig;

/** Build a pino logger from the production options, capturing output to a string. */
function makeCapturingLogger(): { logger: pino.Logger; read: () => string } {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  });
  const opts = buildPinoHttpOptions(CONFIG) as unknown as pino.LoggerOptions;
  const logger = pino({ level: opts.level, serializers: opts.serializers, redact: opts.redact }, stream);
  return { logger, read: () => output };
}

const S = 'S3NT1NEL';

describe('buildPinoHttpOptions (log secrecy)', () => {
  it('drops every header, cookie, body and URL secret, keeping only the allowlist', () => {
    const { logger, read } = makeCapturingLogger();

    logger.info(
      {
        req: {
          id: 'req-42',
          method: 'POST',
          url: `/api/auth/reset-password?token=${S}-token&email=${S}-email`,
          headers: {
            cookie: `th_access=${S}-accesscookie; th_refresh=${S}-refreshcookie`,
            authorization: `Bearer ${S}-bearer`,
            'proxy-authorization': `Basic ${S}-proxyauth`,
            'x-alaris-secret': `${S}-alaris`,
            'x-inbound-secret': `${S}-inbound`,
            'x-api-key': `${S}-apikey`,
          },
          body: { email: `${S}-body-email`, password: `${S}-password` },
        },
        res: {
          statusCode: 200,
          headers: { 'set-cookie': [`th_refresh=${S}-setcookie`] },
        },
      },
      'request completed',
    );

    const out = read();

    // Nothing sensitive leaks — not one sentinel in any field.
    expect(out).not.toContain(S);

    // The allowlist survives.
    expect(out).toContain('"method":"POST"');
    expect(out).toContain('"statusCode":200');
    expect(out).toContain('req-42');
    // Path is retained WITHOUT the query string (which held the token + email).
    expect(out).toContain('"path":"/api/auth/reset-password"');
    expect(out).not.toContain('token=');
    expect(out).not.toContain('email=');
  });

  it('redact strips sensitive paths independently of the serializers (defense-in-depth)', () => {
    // Build a logger with ONLY the redact layer (no serializers) so this test proves
    // redact alone removes secrets — i.e. if a future change weakens/removes the req/res
    // serializers, redact is still an independent backstop. (The previous version logged
    // under the `req` key, where the serializer stripped headers first, making the
    // assertion pass regardless of redact — vacuous.)
    let output = '';
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        output += chunk.toString();
        cb();
      },
    });
    const opts = buildPinoHttpOptions(CONFIG) as unknown as pino.LoggerOptions;
    const logger = pino({ level: opts.level, redact: opts.redact }, stream);

    logger.info({
      req: {
        headers: {
          cookie: `th_access=${S}-cookie`,
          authorization: `Bearer ${S}-bearer`,
          'proxy-authorization': `Basic ${S}-proxy`,
          'x-alaris-secret': `${S}-alaris`,
          'x-inbound-secret': `${S}-inbound`,
          'x-api-key': `${S}-apikey`,
        },
        body: { password: `${S}-password` },
      },
      res: { headers: { 'set-cookie': [`th_refresh=${S}-setcookie`] } },
    });

    expect(output).not.toContain(S);
  });

  it('drives the real pino-http request pipeline and emits no secrets', () => {
    // Highest-fidelity check: run the actual pino-http middleware built from the
    // production options and let it auto-log request completion (so customProps/
    // clientIp, genReqId and the response-completion path are all exercised — not
    // just the serializers in isolation).
    let output = '';
    const stream = new Writable({
      write(chunk: Buffer, _enc, cb) {
        output += chunk.toString();
        cb();
      },
    });
    // pino-http is overloaded (one overload takes a bare stream), which confuses
    // `Parameters<typeof pinoHttp>`; cast to a minimal middleware-factory signature.
    type PinoHttpFactory = (
      opts: object,
      stream: Writable,
    ) => (req: object, res: object, next: () => void) => void;
    const middleware = (pinoHttp as unknown as PinoHttpFactory)(buildPinoHttpOptions(CONFIG) ?? {}, stream);

    const req = Object.assign(new EventEmitter(), {
      method: 'POST',
      url: `/api/auth/login?token=${S}-urltoken&email=${S}-urlemail`,
      headers: {
        cookie: `th_access=${S}-cookie`,
        authorization: `Bearer ${S}-bearer`,
        'x-alaris-secret': `${S}-alaris`,
      },
      socket: { remoteAddress: '203.0.113.7' },
      ip: '203.0.113.7',
    });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      getHeader: () => undefined,
      getHeaders: () => ({ 'set-cookie': [`th_refresh=${S}-setcookie`] }),
      setHeader: () => undefined,
      writableEnded: false,
    });

    middleware(req, res, () => undefined);
    res.emit('finish');

    // Nothing sensitive leaks through the real middleware…
    expect(output).not.toContain(S);
    // …and the allowlist (incl. the trusted client IP via customProps) is present.
    // (statusCode is emitted via the res serializer; its exact value depends on the
    // mocked response lifecycle, so we assert the field is present, not a fixed value.)
    expect(output).toContain('"method":"POST"');
    expect(output).toContain('"statusCode"');
    expect(output).toContain('"path":"/api/auth/login"');
    expect(output).toContain('"clientIp":"203.0.113.7"');
  });
});
