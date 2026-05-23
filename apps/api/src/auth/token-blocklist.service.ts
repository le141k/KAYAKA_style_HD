import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfig, APP_CONFIG } from '../config/configuration';

const KEY_PREFIX = 'th:revoked:'; // th:revoked:<jti> = "1" with TTL = remaining token life

/**
 * Redis-backed access-token revocation (jti blocklist). On logout we add the
 * access token's jti here with a TTL equal to its remaining lifetime, so the
 * JwtAuthGuard rejects it immediately instead of waiting out the ~15-min TTL.
 *
 * Fail-open: if Redis is unreachable, isBlocked() returns false (the short access
 * TTL is the backstop) — we never lock every user out because of a Redis hiccup.
 */
@Injectable()
export class TokenBlocklistService implements OnModuleDestroy {
  private readonly logger = new Logger(TokenBlocklistService.name);
  private readonly redis: Redis;
  /** Throttle the fail-open bypass alert so a Redis outage doesn't flood logs. */
  private lastBypassAlertAt = 0;
  private static readonly BYPASS_ALERT_INTERVAL_MS = 30_000;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    // Connect in the background; swallow errors (fail-open).
    this.redis.connect().catch((err: unknown) => {
      this.logger.warn(`Token blocklist Redis not connected: ${String(err)}`);
    });
    this.redis.on('error', () => {
      /* handled per-call; avoid unhandled 'error' events */
    });
  }

  /** Revoke a jti for `ttlSeconds` (its remaining lifetime). No-op if ttl<=0. */
  async block(jti: string, ttlSeconds: number): Promise<void> {
    if (!jti || ttlSeconds <= 0) return;
    try {
      await this.redis.set(`${KEY_PREFIX}${jti}`, '1', 'EX', Math.ceil(ttlSeconds));
    } catch (err) {
      this.logger.warn(`Failed to blocklist jti ${jti}: ${String(err)}`);
    }
  }

  /**
   * True if the jti was revoked. Fail-open (false) when Redis is unavailable — but
   * emit a throttled ERROR so the "Redis down → token revocation is bypassed"
   * window is observable (alert/metric hook), not silent.
   */
  async isBlocked(jti: string | undefined): Promise<boolean> {
    if (!jti) return false;
    try {
      return (await this.redis.exists(`${KEY_PREFIX}${jti}`)) === 1;
    } catch (err) {
      this.alertRevocationBypass(err);
      return false;
    }
  }

  /** Log (at most once per interval) that revocation checks are being bypassed. */
  private alertRevocationBypass(err: unknown): void {
    const now = Date.now();
    if (now - this.lastBypassAlertAt < TokenBlocklistService.BYPASS_ALERT_INTERVAL_MS) return;
    this.lastBypassAlertAt = now;
    this.logger.error(
      `SECURITY: token revocation check failed — Redis unreachable, fail-open BYPASS active ` +
        `(revoked access tokens are accepted until their ~15-min TTL expires): ${String(err)}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      this.redis.disconnect();
    } catch {
      /* ignore */
    }
  }
}
