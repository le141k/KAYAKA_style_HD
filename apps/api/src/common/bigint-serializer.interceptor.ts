import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

/**
 * Convert every `BigInt` in a response payload to a decimal string.
 *
 * `JSON.stringify` (which NestJS uses to serialize responses) throws on a BigInt, so any
 * endpoint returning a BigInt column (e.g. `EmailQueue.lastSeenUid` / `uidValidity`, an
 * IMAP UID that can exceed 2^31) would otherwise 500. Emitting strings also keeps values
 * that can exceed `Number.MAX_SAFE_INTEGER` exact for clients.
 *
 * Only ARRAYS and PLAIN objects are traversed. Class instances, an Express `Response`
 * (returned by `@Res({ passthrough: true })` handlers — it is deeply cyclic), streams and
 * Buffers/Dates are returned untouched, so this never recurses into a foreign object graph.
 * A `WeakSet` additionally guards against a self-referential plain object.
 */
function convert(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;

  const isArray = Array.isArray(value);
  if (!isArray) {
    // Only descend into plain objects (Object.prototype or null-prototype). Anything with a
    // custom prototype (Response, streams, class instances) is left exactly as-is.
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) return value;
  }
  if (seen.has(value)) return value; // cycle guard
  seen.add(value);

  if (isArray) {
    let changed = false;
    const out = (value as unknown[]).map((item) => {
      const next = convert(item, seen);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = convert(item, seen);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

/** Recursively stringify BigInt values in a response payload (see file doc). */
export function serializeBigInt(value: unknown): unknown {
  return convert(value, new WeakSet<object>());
}

@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serializeBigInt(data)));
  }
}
