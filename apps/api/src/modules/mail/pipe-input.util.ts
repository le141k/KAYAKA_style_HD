import { BadRequestException } from '@nestjs/common';

/** MTA-provided idempotency keys are bounded before they ever reach an index/key. */
export const PIPE_DELIVERY_ID_MAX_BYTES = 256;

// Deliberately conservative printable ASCII subset. It is portable across Postfix,
// Exim and curl, cannot contain whitespace/control bytes and is safe to log.
const PIPE_DELIVERY_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+?=-]*$/;

/** Normalize and validate the trusted MTA delivery id used for PIPE idempotency. */
export function normalizePipeDeliveryId(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new BadRequestException('x-inbound-delivery-id is required for PIPE ingress');
  }
  if (Buffer.byteLength(normalized, 'utf8') > PIPE_DELIVERY_ID_MAX_BYTES) {
    throw new BadRequestException(
      `x-inbound-delivery-id must be at most ${PIPE_DELIVERY_ID_MAX_BYTES} UTF-8 bytes`,
    );
  }
  if (!PIPE_DELIVERY_ID.test(normalized)) {
    throw new BadRequestException('x-inbound-delivery-id contains unsupported characters');
  }
  return normalized;
}

/**
 * Non-throwing counterpart for the Express pre-parser guard. It lets the HTTP layer
 * reject malformed authenticated headers before allocating a potentially large raw
 * RFC822 body; the controller still calls the throwing form as defence in depth.
 */
export function tryNormalizePipeDeliveryId(value: string | undefined): string | null {
  try {
    return normalizePipeDeliveryId(value);
  } catch {
    return null;
  }
}

/** Parse exactly the canonical positive-decimal header syntax used by PIPE. */
export function tryParsePipeQueueId(value: string | undefined): number | null {
  const normalized = value?.trim() ?? '';
  if (!/^[1-9]\d*$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    return null;
  }
  return parsed;
}

/** Header must be a positive, canonical integer id (never a float / exponent). */
export function parsePipeQueueId(value: string | undefined): number {
  const parsed = tryParsePipeQueueId(value);
  if (parsed === null) {
    throw new BadRequestException('x-inbound-queue-id is required and must be a positive integer');
  }
  return parsed;
}
