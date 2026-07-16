import type { Params } from 'nestjs-pino';
import type { AppConfig } from './configuration';

/**
 * Strict-allowlist HTTP logging options (GOAL_PUBLIC_SECURITY S1-1).
 *
 * Security invariant: request/response logs must NEVER carry credentials. We
 * therefore log only an explicit allowlist — method, path (query string stripped),
 * status, duration, request id and the trusted client IP — and drop every request
 * and response header and every body.
 *
 * Two independent layers enforce this so a change to one cannot silently reopen the
 * leak:
 *  1. custom `serializers` reduce req/res to the allowlisted fields, so headers and
 *     bodies never enter the serialized shape in the first place;
 *  2. `redact … remove: true` strips known-sensitive paths as defense in depth, in
 *     case a raw object (e.g. `logger.info({ req })`) is ever logged directly.
 *
 * The query string is dropped because it can carry password-reset / magic-link
 * tokens and `?email=` requester lookups.
 */
export function buildPinoHttpOptions(config: AppConfig): Params['pinoHttp'] {
  const isDev = config.NODE_ENV === 'development';

  return {
    level: config.TELECOM_HD_LOG_LEVEL,
    transport: isDev ? { target: 'pino-pretty', options: { colorize: true } } : undefined,

    // Attach the trusted client IP explicitly. Express resolves `req.ip` from the
    // proxy chain via `trust proxy` (set in main.ts); it is not a secret.
    customProps: (req: unknown) => {
      const r = req as { ip?: string; raw?: { ip?: string } };
      return { clientIp: r.ip ?? r.raw?.ip };
    },

    serializers: {
      req(req: { id?: unknown; method?: string; url?: string }) {
        const url = typeof req.url === 'string' ? req.url : '';
        const q = url.indexOf('?');
        return {
          id: req.id,
          method: req.method,
          // Path only — the query string can carry reset/magic-link tokens and
          // `?email=` requester lookups, so it must never be logged.
          path: q === -1 ? url : url.slice(0, q),
        };
      },
      res(res: { statusCode?: number }) {
        return { statusCode: res.statusCode };
      },
      err(err: Error & { type?: string }) {
        // Keep only non-sensitive diagnostic fields; never spread arbitrary
        // properties a thrown value might carry (e.g. a request body).
        return { type: err.type ?? err.name, message: err.message, stack: err.stack };
      },
    },

    redact: {
      paths: [
        'req.headers',
        'res.headers',
        'req.body',
        'res.body',
        'req.remoteAddress',
        'req.remotePort',
        // Explicit header paths in case a raw object is ever logged directly.
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["set-cookie"]',
        'res.headers["set-cookie"]',
        'req.headers["proxy-authorization"]',
        'req.headers["x-inbound-secret"]',
        'req.headers["x-alaris-secret"]',
        'req.headers["x-api-key"]',
      ],
      remove: true,
    },
  };
}
