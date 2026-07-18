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
 */
export function serializeBigInt(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = serializeBigInt(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const next = serializeBigInt(item);
    if (next !== item) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

@Injectable()
export class BigIntSerializerInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((data) => serializeBigInt(data)));
  }
}
