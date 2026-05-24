import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { APP_CONFIG } from '../config/configuration';
import { loadConfig } from '../config/configuration';

/**
 * HealthModule — exposes GET /api/health for container healthchecks and ops
 * tooling.  No database migrations, no queue registration; just a thin
 * controller that probes Postgres and Redis.
 *
 * PrismaService is available globally (PrismaModule is @Global), so we only
 * need to re-provide APP_CONFIG here for the controller.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: APP_CONFIG,
      useValue: loadConfig(),
    },
  ],
})
export class HealthModule {}
