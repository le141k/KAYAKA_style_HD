import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHmac, hkdfSync } from 'node:crypto';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { normalizeEmail } from '../common/email.util';

const WINDOW_SECONDS = 60 * 60;
const GLOBAL_LIMIT = 100;
const IP_LIMIT = 5;
const IDENTITY_LIMIT = 3;

const CONSUME_LUA = `
local ttl = tonumber(ARGV[1])
local out = {}
for i, key in ipairs(KEYS) do
  local n = redis.call('INCR', key)
  if n == 1 then redis.call('EXPIRE', key, ttl) end
  out[i] = n
end
return out
`;

/**
 * Cluster-wide password-reset mail-bomb protection. Keys contain only HMAC
 * pseudonyms; raw email/IP values never enter Redis. Unlike login throttling,
 * this control fails closed in production because an unavailable quota store
 * must not turn the public endpoint into an unlimited SMTP relay.
 */
@Injectable()
export class PasswordResetThrottleService implements OnModuleDestroy {
  private readonly logger = new Logger(PasswordResetThrottleService.name);
  private readonly redis: Redis;
  private readonly hmacKey: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.hmacKey = Buffer.from(
      hkdfSync('sha256', config.TELECOM_HD_JWT_ACCESS_SECRET, '', 'th-password-reset-quota-v1', 32),
    );
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.connect().catch(() => undefined);
    this.redis.on('error', () => undefined);
  }

  async consume(email: string, ip?: string): Promise<void> {
    const keys = [
      'th:password-reset:global',
      `th:password-reset:identity:${this.pseudonym(normalizeEmail(email))}`,
    ];
    const limits = [GLOBAL_LIMIT, IDENTITY_LIMIT];
    if (ip) {
      keys.push(`th:password-reset:ip:${this.pseudonym(ip)}`);
      limits.push(IP_LIMIT);
    }

    let counts: number[];
    try {
      counts = (await this.redis.eval(CONSUME_LUA, keys.length, ...keys, String(WINDOW_SECONDS))) as number[];
    } catch {
      if (this.config.NODE_ENV === 'production') {
        throw new ServiceUnavailableException('Password reset is temporarily unavailable');
      }
      return;
    }

    if (counts.some((count, index) => count > (limits[index] ?? 0))) {
      this.logger.warn('Password-reset quota engaged');
      throw new HttpException('Too many requests. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private pseudonym(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value).digest('hex').slice(0, 32);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // Already disconnected.
    }
  }
}
