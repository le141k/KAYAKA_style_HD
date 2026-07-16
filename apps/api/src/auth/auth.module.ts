import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { AuthService, MAIL_SERVICE_TOKEN } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { ClientPortalGuard } from './client-portal.guard';
import { TokenBlocklistService } from './token-blocklist.service';
import { MailService } from '../modules/mail/mail.service';
import { loadConfig, APP_CONFIG } from '../config/configuration';

const config = loadConfig();

@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: config.TELECOM_HD_JWT_ACCESS_SECRET,
      signOptions: { expiresIn: config.TELECOM_HD_JWT_ACCESS_TTL },
    }),
    // Narrow acyclic reset-mail adapter (GOAL_PUBLIC_SECURITY S1-3). We register only
    // the 'mail' producer queue and provide MailService LOCALLY, rather than importing
    // MailModule. Importing mail.module.ts at the top level would eagerly pull the
    // Mail→Tickets→Sla→Mail module-load cycle before it is initialized (a JS
    // "Cannot access 'MailModule' before initialization" at boot); importing only
    // mail.service.ts is cycle-free. This local MailService enqueues onto the same
    // Redis 'mail' queue that MailModule's processor consumes.
    BullModule.registerQueue({ name: 'mail' }),
  ],
  controllers: [AuthController],
  providers: [
    // Provide config locally so AuthService can inject it via APP_CONFIG
    { provide: APP_CONFIG, useValue: config },
    // Local MailService instance (see the adapter note above) + bind the reset-mail
    // port to it. Previously the token was `useValue: undefined`, which silently
    // disabled reset mail and forced the dev fallback that LOGGED the raw reset URL.
    MailService,
    { provide: MAIL_SERVICE_TOKEN, useExisting: MailService },
    AuthService,
    JwtAuthGuard,
    PermissionsGuard,
    ClientPortalGuard,
    TokenBlocklistService,
  ],
  exports: [
    AuthService,
    JwtAuthGuard,
    PermissionsGuard,
    ClientPortalGuard,
    TokenBlocklistService,
    JwtModule,
    APP_CONFIG,
    MAIL_SERVICE_TOKEN,
  ],
})
export class AuthModule {}
