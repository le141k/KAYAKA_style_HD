import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { AbuseQuotaService } from './abuse-quota.service';
import { AttachmentCapacityService } from './attachment-capacity.service';

const MIB = 1024 * 1024;
export type UploadAdmissionChannel = 'public' | 'client';

/** Shared pre-Multer admission for anonymous and verified-client uploads. */
@Injectable()
export class UploadAdmissionService {
  constructor(
    private readonly quota: AbuseQuotaService,
    private readonly capacity: AttachmentCapacityService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Validate framing before any interceptor can consume request bytes. Public
   * upload routes deliberately reject chunked/missing lengths: a reservation
   * must have a finite, authenticated cost before Multer opens quarantine files.
   */
  validateContentLength(request: Request, channel: UploadAdmissionChannel): number {
    if (this.config.NODE_ENV === 'production') {
      const enabled =
        channel === 'public'
          ? this.config.TELECOM_HD_PUBLIC_UPLOAD_ENABLED
          : this.config.TELECOM_HD_CLIENT_UPLOAD_ENABLED;
      if (!enabled) throw new NotFoundException();
    }
    if (request.headers['transfer-encoding'] !== undefined) {
      throw new BadRequestException('A fixed Content-Length is required for uploads');
    }
    const raw = request.headers['content-length'];
    if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) {
      throw new BadRequestException('A fixed Content-Length is required for uploads');
    }
    const bytes = Number(raw);
    if (!Number.isSafeInteger(bytes)) {
      throw new BadRequestException('Invalid Content-Length');
    }
    if (bytes > this.config.TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB * MIB) {
      throw new PayloadTooLargeException('Upload request is too large');
    }
    return bytes;
  }

  /** Reserve the request and its bytes exactly once, then recheck shared capacity. */
  async reserve(
    request: Request,
    bytes: number,
    channel: UploadAdmissionChannel,
    identity?: string,
  ): Promise<void> {
    await this.quota.consume({
      action: `${channel}-upload-request`,
      ip: request.ip,
      identity,
      cost: 1,
      windowSeconds: 3600,
      globalLimit: 240,
      ipLimit: 12,
      identityLimit: identity ? 24 : undefined,
    });
    await this.quota.consume({
      action: `${channel}-upload-bytes`,
      ip: request.ip,
      identity,
      cost: bytes,
      windowSeconds: 3600,
      globalLimit: 1024 * MIB,
      ipLimit: 128 * MIB,
      identityLimit: identity ? 256 * MIB : undefined,
    });
    await this.capacity.assertCanAccept(bytes, 1);
  }
}
