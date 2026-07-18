import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/configuration';

interface TurnstileResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  challenge_ts?: string;
}

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;
const MAX_CHALLENGE_AGE_MS = 5 * 60_000;

/** Server-side, action-bound Cloudflare Turnstile validation. Raw tokens are never logged. */
@Injectable()
export class TurnstileService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async verify(token: string | undefined, expectedAction: string, remoteIp?: string): Promise<void> {
    const secret = this.config.TELECOM_HD_TURNSTILE_SECRET;
    if (!secret && this.config.NODE_ENV !== 'production') return;
    if (!secret) throw new ServiceUnavailableException('Public challenge is unavailable');
    if (!token || token.length > MAX_TOKEN_LENGTH) {
      throw new BadRequestException('Public challenge validation failed');
    }

    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    let result: TurnstileResponse;
    try {
      const response = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`siteverify status ${response.status}`);
      result = (await response.json()) as TurnstileResponse;
    } catch {
      throw new ServiceUnavailableException('Public challenge is temporarily unavailable');
    } finally {
      clearTimeout(timeout);
    }

    const expectedHostname = (
      this.config.TELECOM_HD_TURNSTILE_HOSTNAME ?? new URL(this.config.TELECOM_HD_PUBLIC_URL).hostname
    ).toLowerCase();
    const challengeTime = result.challenge_ts ? Date.parse(result.challenge_ts) : Number.NaN;
    const age = Date.now() - challengeTime;
    const fresh = Number.isFinite(challengeTime) && age >= -30_000 && age <= MAX_CHALLENGE_AGE_MS;

    if (
      result.success !== true ||
      result.action !== expectedAction ||
      result.hostname?.toLowerCase() !== expectedHostname ||
      !fresh
    ) {
      throw new BadRequestException('Public challenge validation failed');
    }
  }
}
