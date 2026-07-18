import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { LoggerModule } from 'nestjs-pino';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './prisma/prisma.module';
import { loadConfig, APP_CONFIG } from './config/configuration';
import { buildPinoHttpOptions } from './config/logging';
import { AuthModule } from './auth/auth.module';
import { ClientAuthModule } from './modules/client-auth/client-auth.module';
import { StaffModule } from './modules/staff/staff.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { TicketsModule } from './modules/tickets/tickets.module';
import { AlarisModule } from './modules/alaris/alaris.module';
import { SlaModule } from './modules/sla/sla.module';
import { MailModule } from './modules/mail/mail.module';
import { NewsModule } from './modules/news/news.module';
import { KnowledgebaseModule } from './modules/knowledgebase/knowledgebase.module';
import { TroubleshooterModule } from './modules/troubleshooter/troubleshooter.module';
import { ReportsModule } from './modules/reports/reports.module';
import { WorkflowModule } from './modules/workflow/workflow.module';
import { AdminModule } from './modules/admin/admin.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { CustomFieldsModule } from './modules/custom-fields/custom-fields.module';
import { TimeTrackingModule } from './modules/time-tracking/time-tracking.module';
import { FollowUpsModule } from './modules/follow-ups/follow-ups.module';
import { SavedViewsModule } from './modules/saved-views/saved-views.module';
import { HealthModule } from './health/health.module';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PermissionsGuard } from './auth/permissions.guard';
import { CsrfGuard } from './auth/csrf.guard';
import { PublicSecurityModule } from './security/public-security.module';

const config = loadConfig();
const redisUrl = new URL(config.REDIS_URL);

/**
 * Root application module.
 *
 * AppConfig is provided as a plain value token so every service can inject it
 * via constructor DI without a dynamic ConfigModule factory.
 *
 * BullMQ: add BullModule.forRoot({ connection: parseRedisUrl(config.REDIS_URL) })
 * once @nestjs/bullmq is installed and the SLA queue processor is wired.
 */
@Module({
  imports: [
    // Global rate-limiting (300 req / 60 s per IP — headroom for a data-heavy SPA
    // that fires several React Query calls per page); login has a stricter override.
    // Backed by Redis so the limit is shared across API instances — an in-memory
    // store would let an attacker bypass the login limit behind a load balancer.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 300 }],
      storage: new ThrottlerStorageRedisService(config.REDIS_URL),
    }),

    // Structured JSON logging via Pino. Uses a strict allowlist so request logs
    // never carry credentials — see buildPinoHttpOptions / GOAL_PUBLIC_SECURITY S1-1.
    LoggerModule.forRoot({ pinoHttp: buildPinoHttpOptions(config) }),

    // Background queues (BullMQ) + in-process domain events. Carry the password
    // from REDIS_URL through — prod requires Redis auth (see docker-compose.prod.yml).
    BullModule.forRoot({
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port) || 6379,
        ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
        ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
      },
    }),
    EventEmitterModule.forRoot(),

    // Core database access (global — available everywhere without explicit import)
    PrismaModule,

    // Feature modules
    AuthModule,
    PublicSecurityModule,
    ClientAuthModule,
    StaffModule,
    UsersModule,
    OrganizationsModule,
    DepartmentsModule,
    TicketsModule,
    AlarisModule,
    SlaModule,
    MailModule,
    NewsModule,
    KnowledgebaseModule,
    TroubleshooterModule,
    ReportsModule,
    WorkflowModule,
    AdminModule,
    AttachmentsModule,
    CustomFieldsModule,
    TimeTrackingModule,
    FollowUpsModule,
    SavedViewsModule,
    HealthModule,
  ],
  providers: [
    // Provide AppConfig as a VALUE token so it can be constructor-injected via @Inject(APP_CONFIG)
    {
      provide: APP_CONFIG,
      useValue: config,
    },
    // Map Prisma known-request errors (P2025/P2003/P2002) to 404/400/409 instead of 500
    {
      provide: APP_FILTER,
      useClass: PrismaExceptionFilter,
    },
    // CSRF: reject cross-origin cookie-authenticated mutations before anything else
    // (GOAL_PUBLIC_SECURITY S3-5). Safe methods, Bearer-auth and cookieless requests pass.
    {
      provide: APP_GUARD,
      useClass: CsrfGuard,
    },
    // Enforce ThrottlerModule limits globally (coexists with JWT/Permissions guards)
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    // Global JWT backstop: every route requires a valid access token UNLESS it is
    // decorated with @Public(). This closes the "undecorated route is wide open"
    // gap — routes that forgot @RequirePermissions() are no longer anonymous.
    // The guard honours IS_PUBLIC metadata, so login / refresh / kb-public /
    // departments-public / alaris-webhook (all @Public) continue to work tokenless.
    // It runs BEFORE PermissionsGuard so req.user is populated first.
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Global permissions backstop: enforces @RequirePermissions() metadata. Routes
    // with no PERMISSIONS metadata fall through (return true), so an authenticated
    // route without explicit permissions still works as before.
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
  exports: [APP_CONFIG],
})
export class AppModule {}
