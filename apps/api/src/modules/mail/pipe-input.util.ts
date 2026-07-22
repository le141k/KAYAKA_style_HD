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

/** Header must be a positive, canonical integer id (never a float / exponent). */
export function parsePipeQueueId(value: string | undefined): number {
  const normalized = value?.trim() ?? '';
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new BadRequestException('x-inbound-queue-id is required and must be a positive integer');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) {
    throw new BadRequestException('x-inbound-queue-id is outside the supported range');
  }
  return parsed;
}
