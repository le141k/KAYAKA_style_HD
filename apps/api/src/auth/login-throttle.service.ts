import { HttpException, HttpStatus, Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { createHmac } from 'crypto';
import { AppConfig, APP_CONFIG } from '../config/configuration';

const KEY_PREFIX = 'th:login:'; // th:login:<hmac(email)>:<ip> = failure count, sliding window

/** Failures (per IP + email) within the window before further attempts are throttled. */
const FAILURE_THRESHOLD = 10;
/** Sliding window in seconds (failures older than this expire). */
const WINDOW_SECONDS = 15 * 60;

/**
 * Login-abuse throttle (GOAL_PUBLIC_SECURITY S3-7).
 *
 * Counts FAILED logins per (trusted client IP + HMAC(email)) in Redis and returns a
 * generic 429 once the threshold is passed — slowing credential stuffing WITHOUT ever
 * locking an account: the key is scoped to one IP, so a known account stays reachable
 * from other IPs, and the counter self-expires. The email is HMAC-ed so raw addresses
 * are never stored in Redis. Fail-OPEN: a Redis outage never blocks logins (the per-IP
 * `@Throttle` is the backstop). The response is identical regardless of whether the
 * email exists, so it discloses nothing.
 */
@Injectable()
export class LoginThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(LoginThrottleService.name);
  private readonly redis: Redis;
  private readonly hmacSecret: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.hmacSecret = config.TELECOM_HD_JWT_ACCESS_SECRET;
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.connect().catch((err: unknown) => {
      this.logger.warn(`Login-throttle Redis not connected: ${String(err)}`);
    });
    this.redis.on('error', () => {
      /* handled per-call; avoid unhandled 'error' events */
    });
  }

  private key(email: string, ip: string): string {
    const emailHash = createHmac('sha256', this.hmacSecret)
      .update(email.trim().toLowerCase())
      .digest('hex')
      .slice(0, 32);
    return `${KEY_PREFIX}${emailHash}:${ip}`;
  }

  /** Throw a generic 429 if this (IP + email) is over the failure threshold. Fail-open. */
  async assertNotThrottled(email: string, ip?: string): Promise<void> {
    if (!ip) return;
    let count: string | null;
    try {
      count = await this.redis.get(this.key(email, ip));
    } catch {
      return; // Redis down → fail open
    }
    if (count !== null && Number(count) >= FAILURE_THRESHOLD) {
      throw new HttpException(
        'Too many login attempts. Please wait a few minutes and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Record one failed attempt (INCR + sliding TTL). Best-effort. */
  async recordFailure(email: string, ip?: string): Promise<void> {
    if (!ip) return;
    try {
      const k = this.key(email, ip);
      const n = await this.redis.incr(k);
      // (Re)set the window on every failure so sustained abuse keeps the key alive.
      await this.redis.expire(k, WINDOW_SECONDS);
      if (n === FAILURE_THRESHOLD) {
        this.logger.warn(`Login throttle engaged for an email/IP pair (${n} failures)`);
      }
    } catch {
      /* best-effort */
    }
  }

  /** Clear the counter after a successful login. Best-effort. */
  async clear(email: string, ip?: string): Promise<void> {
    if (!ip) return;
    try {
      await this.redis.del(this.key(email, ip));
    } catch {
      /* best-effort */
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      /* ignore */
    }
  }
}
