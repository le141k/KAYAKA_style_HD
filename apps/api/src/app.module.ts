import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { BullModule } from '@nestjs/bullmq';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './prisma/prisma.module';
import { loadConfig, APP_CONFIG } from './config/configuration';
import { AuthModule } from './auth/auth.module';
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
import { PrismaExceptionFilter } from './common/prisma-exception.filter';

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
    // Structured JSON logging via Pino
    LoggerModule.forRoot({
      pinoHttp: {
        level: config.TELECOM_HD_LOG_LEVEL,
        transport:
          config.NODE_ENV === 'development'
            ? { target: 'pino-pretty', options: { colorize: true } }
            : undefined,
      },
    }),

    // Background queues (BullMQ) + in-process domain events
    BullModule.forRoot({
      connection: { host: redisUrl.hostname, port: Number(redisUrl.port) || 6379 },
    }),
    EventEmitterModule.forRoot(),

    // Core database access (global — available everywhere without explicit import)
    PrismaModule,

    // Feature modules
    AuthModule,
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
  ],
  exports: [APP_CONFIG],
})
export class AppModule {}
