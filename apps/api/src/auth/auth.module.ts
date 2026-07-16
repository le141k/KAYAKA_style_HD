import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService, MAIL_SERVICE_TOKEN } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { TokenBlocklistService } from './token-blocklist.service';
import { MailModule } from '../modules/mail/mail.module';
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
    // Import MailModule so AuthService can dispatch security mail (password reset).
    // This edge is acyclic: nothing in MailModule's subtree imports AuthModule
    // (auth guards are provided globally via @Global), so no forwardRef is needed.
    MailModule,
  ],
  controllers: [AuthController],
  providers: [
    // Provide config locally so AuthService can inject it via APP_CONFIG
    { provide: APP_CONFIG, useValue: config },
    // Bind the reset-mail port to the real MailService (imported above). Previously
    // this was `useValue: undefined`, which silently disabled reset mail and forced
    // the dev fallback that LOGGED the raw reset URL in every environment.
    { provide: MAIL_SERVICE_TOKEN, useExisting: MailService },
    AuthService,
    JwtAuthGuard,
    PermissionsGuard,
    TokenBlocklistService,
  ],
  exports: [
    AuthService,
    JwtAuthGuard,
    PermissionsGuard,
    TokenBlocklistService,
    JwtModule,
    APP_CONFIG,
    MAIL_SERVICE_TOKEN,
  ],
})
export class AuthModule {}
