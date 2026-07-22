import { Module } from '@nestjs/common';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';
import { ClientAuthModule } from '../client-auth/client-auth.module';
import { OrphanCleanupService } from './orphan-cleanup.service';
import { TicketAccessModule } from '../tickets/ticket-access.module';

@Module({
  // ClientAuthModule provides ClientAuthGuard for the owner-scoped client download (S2-8).
  // It imports no feature modules, so this edge is cycle-free.
  imports: [ClientAuthModule, TicketAccessModule],
  controllers: [AttachmentsController],
  providers: [AttachmentsService, StorageService, OrphanCleanupService],
  // MailModule reads durable outbox attachment snapshots through the same
  // traversal-safe storage resolver; exporting the service avoids duplicating
  // filesystem path logic in the SMTP worker.
  exports: [AttachmentsService, StorageService],
})
export class AttachmentsModule {}
