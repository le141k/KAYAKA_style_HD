import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AbuseQuotaService } from './abuse-quota.service';
import { ClamAvService } from './clamav.service';
import { TurnstileService } from './turnstile.service';
import { PublicWriteGuard } from './public-write.guard';
import { PublicUploadChallengeGuard } from './public-upload-challenge.guard';
import { AttachmentCapacityService } from './attachment-capacity.service';
import { UploadAdmissionService } from './upload-admission.service';
import { ClientUploadAdmissionGuard } from './client-upload-admission.guard';

/** Shared public-edge controls used by ticket, client-auth and attachment entry points. */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    AbuseQuotaService,
    ClamAvService,
    TurnstileService,
    PublicWriteGuard,
    AttachmentCapacityService,
    UploadAdmissionService,
    PublicUploadChallengeGuard,
    ClientUploadAdmissionGuard,
  ],
  exports: [
    AbuseQuotaService,
    ClamAvService,
    TurnstileService,
    PublicWriteGuard,
    AttachmentCapacityService,
    UploadAdmissionService,
    PublicUploadChallengeGuard,
    ClientUploadAdmissionGuard,
  ],
})
export class PublicSecurityModule {}
