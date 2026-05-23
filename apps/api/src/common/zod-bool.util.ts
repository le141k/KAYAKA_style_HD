import { z } from 'zod';

/**
 * Parse a query-string boolean explicitly.
 *
 * `z.coerce.boolean()` is a footgun for query params: it does `Boolean(value)`,
 * so ANY non-empty string — including "false", "0", "no" — becomes `true`.
 * That silently inverts `?flag=false`. These helpers treat only the canonical
 * truthy tokens as `true`; everything else (incl. "false"/"0"/"no") is `false`.
 */
function toBool(v: unknown): boolean {
  return typeof v === 'string' ? ['true', '1', 'yes', 'on'].includes(v.toLowerCase()) : Boolean(v);
}

/** Optional boolean query param: absent → undefined; otherwise parsed strictly. */
export function optionalBoolParam() {
  return z.preprocess((v) => (v === undefined ? undefined : toBool(v)), z.boolean().optional());
}

/** Boolean query param with a default when absent; otherwise parsed strictly. */
export function boolParamWithDefault(defaultValue: boolean) {
  return z.preprocess((v) => (v === undefined ? defaultValue : toBool(v)), z.boolean());
}
