import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PermissionsGuard } from './permissions.guard';
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
    AuthService,
    JwtAuthGuard,
    PermissionsGuard,
  ],
  exports: [AuthService, JwtAuthGuard, PermissionsGuard, JwtModule, APP_CONFIG],
})
export class AuthModule {}
