import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';
import { ClientAuthModule } from '../client-auth/client-auth.module';
import { OrphanCleanupService } from './orphan-cleanup.service';

@Module({
  // ClientAuthModule provides ClientAuthGuard for the owner-scoped client download (S2-8).
  // It imports no feature modules, so this edge is cycle-free.
  imports: [ClientAuthModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, StorageService, OrphanCleanupService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
