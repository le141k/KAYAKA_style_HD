import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService, MAIL_SERVICE_TOKEN } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
import { TokenBlocklistService } from './token-blocklist.service';
import { SessionRevocationService } from './session-revocation.service';
import { loadConfig, APP_CONFIG } from '../config/configuration';

const config = loadConfig();

@Global()
@Module({
  imports: [
    JwtModule.register({
      secret: config.TELECOM_HD_JWT_ACCESS_SECRET,
      signOptions: { expiresIn: config.TELECOM_HD_JWT_ACCESS_TTL },
    }),
  ],
  controllers: [AuthController],
  providers: [
    // Provide config locally so AuthService can inject it via APP_CONFIG
    { provide: APP_CONFIG, useValue: config },
    // MAIL_SERVICE_TOKEN is satisfied by AppModule when MailModule is imported.
    // Using undefined here means AuthModule itself doesn't import MailModule
    // (avoiding a circular dependency); AppModule overrides this with the real
    // MailService via the MAIL_SERVICE_TOKEN provider.
    { provide: MAIL_SERVICE_TOKEN, useValue: undefined },
    AuthService,
    JwtAuthGuard,
    PermissionsGuard,
    TokenBlocklistService,
    SessionRevocationService,
  ],
  exports: [
    AuthService,
    JwtAuthGuard,
    PermissionsGuard,
    TokenBlocklistService,
    SessionRevocationService,
    JwtModule,
    APP_CONFIG,
    MAIL_SERVICE_TOKEN,
  ],
})
export class AuthModule {}
