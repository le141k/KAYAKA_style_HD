import {
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import Redis from 'ioredis';
import { Public } from '../auth/auth.decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig, APP_CONFIG } from '../config/configuration';

/** Shape returned by GET /api/health */
export interface HealthResponse {
  status: 'ok' | 'error';
  db: 'up' | 'down';
  redis: 'up' | 'down';
}

/**
 * Lightweight health-check controller.
 *
 * Probes Postgres (SELECT 1 via PrismaService) and Redis (PING via a
 * dedicated ioredis client) with a 800 ms timeout each.  Returns 200 when
 * both are up, 503 with the failing component(s) marked 'down' otherwise.
 *
 * The route is @Public() so container healthchecks and load-balancer
 * probes don't need a JWT.
 */
@ApiTags('health')
@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly logger = new Logger(HealthController.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    // Dedicated lightweight client — lazyConnect so we don't fail the module
    // boot if Redis is temporarily unavailable.
    this.redis = new Redis(config.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      connectTimeout: 800,
      commandTimeout: 800,
    });
    this.redis.connect().catch((err: unknown) => {
      this.logger.warn(`Health Redis client connect failed: ${String(err)}`);
    });
    this.redis.on('error', () => {
      /* suppress unhandled-error events; errors are caught per-call */
    });
  }

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Dependency health check (public)' })
  @ApiResponse({ status: 200, description: 'All dependencies healthy' })
  @ApiResponse({ status: 503, description: 'One or more dependencies unhealthy' })
  async check(): Promise<HealthResponse> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);

    const allOk = db === 'up' && redis === 'up';

    const body: HealthResponse = { status: allOk ? 'ok' : 'error', db, redis };

    if (!allOk) {
      // Throw with the body so the response carries a 503 status code.
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }

    return body;
  }

  /** Close the dedicated Redis client on shutdown so it doesn't leak a connection. */
  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DB probe timeout')), 800)),
      ]);
      return 'up';
    } catch (err) {
      this.logger.warn(`Health DB check failed: ${String(err)}`);
      return 'down';
    }
  }

  private async checkRedis(): Promise<'up' | 'down'> {
    try {
      const result = await Promise.race([
        this.redis.ping(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Redis probe timeout')), 800)),
      ]);
      return result === 'PONG' ? 'up' : 'down';
    } catch (err) {
      this.logger.warn(`Health Redis check failed: ${String(err)}`);
      return 'down';
    }
  }
}
