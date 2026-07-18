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

const CONSUME_LUA = `
local cost = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local out = {}
for i, key in ipairs(KEYS) do
  local n = redis.call('INCRBY', key, cost)
  if n == cost then redis.call('EXPIRE', key, ttl) end
  out[i] = n
end
return out
`;

export interface AbuseQuota {
  action: string;
  ip?: string;
  identity?: string;
  cost?: number;
  windowSeconds: number;
  globalLimit: number;
  ipLimit?: number;
  identityLimit?: number;
}

/** Redis-backed global + pseudonymous per-IP/identity emergency quotas for public writes. */
@Injectable()
export class AbuseQuotaService implements OnModuleDestroy {
  private readonly logger = new Logger(AbuseQuotaService.name);
  private readonly redis: Redis;
  private readonly hmacKey: Buffer;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.hmacKey = Buffer.from(
      hkdfSync('sha256', config.TELECOM_HD_JWT_ACCESS_SECRET, '', 'th-public-abuse-v1', 32),
    );
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.connect().catch(() => undefined);
    this.redis.on('error', () => undefined);
  }

  async consume(quota: AbuseQuota): Promise<void> {
    const keys = [`th:abuse:${quota.action}:global`];
    const limits = [quota.globalLimit];
    if (quota.ip && quota.ipLimit) {
      keys.push(`th:abuse:${quota.action}:ip:${this.pseudonym(quota.ip)}`);
      limits.push(quota.ipLimit);
    }
    if (quota.identity && quota.identityLimit) {
      keys.push(`th:abuse:${quota.action}:id:${this.pseudonym(quota.identity)}`);
      limits.push(quota.identityLimit);
    }

    let counts: number[];
    try {
      counts = (await this.redis.eval(
        CONSUME_LUA,
        keys.length,
        ...keys,
        String(quota.cost ?? 1),
        String(quota.windowSeconds),
      )) as number[];
    } catch {
      const publicWritesEnabled =
        this.config.TELECOM_HD_CLIENT_PORTAL_ENABLED ||
        this.config.TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED ||
        this.config.TELECOM_HD_PUBLIC_UPLOAD_ENABLED ||
        this.config.TELECOM_HD_CLIENT_UPLOAD_ENABLED;
      if (this.config.NODE_ENV === 'production' && publicWritesEnabled) {
        throw new ServiceUnavailableException('Public submission is temporarily unavailable');
      }
      return;
    }

    if (counts.some((count, index) => count > (limits[index] ?? 0))) {
      this.logger.warn(`Public abuse quota engaged for action ${quota.action}`);
      throw new HttpException('Too many requests. Please try again later.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private pseudonym(value: string): string {
    return createHmac('sha256', this.hmacKey).update(value.trim().toLowerCase()).digest('hex').slice(0, 32);
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      // already disconnected
    }
  }
}
