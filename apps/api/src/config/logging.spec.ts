import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import pino from 'pino';
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

  it('never emits an inbound/alaris webhook secret passed as a raw header object', () => {
    const { logger, read } = makeCapturingLogger();

    // Defense-in-depth: even if a raw req is logged directly (bypassing the HTTP
    // serializer path), redact removes the sensitive header paths.
    logger.info({ req: { headers: { 'x-alaris-secret': `${S}-directsecret` } } });

    expect(read()).not.toContain(S);
  });
});
