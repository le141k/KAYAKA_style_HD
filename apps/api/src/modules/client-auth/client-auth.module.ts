import { Module } from '@nestjs/common';
import { ClientAuthService } from './client-auth.service';
import { ClientAuthController } from './client-auth.controller';
import { ClientAuthGuard } from './client-auth.guard';

/**
 * Verified client (customer) authentication (GOAL_PUBLIC_SECURITY S2). Depends only on
 * the global PrismaService, APP_CONFIG and the reset mailer token (all @Global), so it
 * needs no imports. Exports the service + guard so the tickets/attachments modules can
 * authorize client-owned routes.
 */
@Module({
  controllers: [ClientAuthController],
  providers: [ClientAuthService, ClientAuthGuard],
  exports: [ClientAuthService, ClientAuthGuard],
})
export class ClientAuthModule {}
