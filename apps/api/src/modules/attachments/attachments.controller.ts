import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { mkdirSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { Public, RequirePermissions } from '../../auth/auth.decorators';
import { ClientAuthenticated, CurrentClient } from '../client-auth/client-auth.decorators';
import type { ClientPrincipal } from '../client-auth/client-auth.service';
import type { Attachment } from '@prisma/client';
import { PERMISSIONS } from '../../auth/permissions';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';
import { PublicWrite } from '../../security/public-write.guard';
import { PublicUploadChallengeGuard } from '../../security/public-upload-challenge.guard';
import { ClientUploadAdmissionGuard } from '../../security/client-upload-admission.guard';

// Anon upload throttle — mirrors the public submit limit so an unauthenticated
// caller cannot flood storage. Env-overridable (e2e/dev raise it for determinism).
const PUBLIC_UPLOAD_LIMIT = Number(process.env['TELECOM_HD_PUBLIC_UPLOAD_LIMIT']) || 12;
const MULTER_MAX_SIZE_MB = Math.max(1, Number(process.env['TELECOM_HD_UPLOAD_MAX_SIZE_MB']) || 25);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** MIME types accepted by the upload endpoints. */
const ALLOWED_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/msword',
  // NOTE: 'application/octet-stream' deliberately removed — it accepted any
  // binary (executables, scripts) by simply declaring that generic type.
]);

function buildMulterOpts(maxSizeMb: number) {
  return {
    storage: diskStorage({
      destination: (_req, _file, cb) => {
        const dir = join(process.env['TELECOM_HD_UPLOAD_DIR'] ?? '/tmp', 'quarantine');
        try {
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          cb(null, dir);
        } catch (err) {
          cb(err as Error, dir);
        }
      },
      filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
    }),
    limits: { fileSize: maxSizeMb * 1024 * 1024, files: 10, fields: 5, parts: 15 },
    fileFilter: (
      _req: Request,
      file: Express.Multer.File,
      cb: (err: Error | null, accept: boolean) => void,
    ) => {
      if (ALLOWED_MIMES.has(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new BadRequestException(`File type ${file.mimetype} is not allowed`), false);
      }
    },
  };
}

@Controller('attachments')
export class AttachmentsController {
  private readonly logger = new Logger(AttachmentsController.name);

  constructor(
    private readonly attachmentsService: AttachmentsService,
    private readonly storageService: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Staff-authenticated upload: up to 10 files, requires TICKET_REPLY permission. */
  @Post('upload')
  @RequirePermissions(PERMISSIONS.TICKET_REPLY)
  @UseInterceptors(FilesInterceptor('files', 10, buildMulterOpts(MULTER_MAX_SIZE_MB)))
  async upload(
    @UploadedFiles() files: Express.Multer.File[],
  ): Promise<{ attachments: { id: number; fileName: string; mimeType: string; size: number }[] }> {
    if (!files?.length) throw new BadRequestException('No files provided');

    const maxSizeMb = this.config.TELECOM_HD_UPLOAD_MAX_SIZE_MB;
    for (const f of files) {
      if (f.size > maxSizeMb * 1024 * 1024) {
        throw new BadRequestException(`File ${f.originalname} exceeds the ${maxSizeMb} MB limit`);
      }
    }

    const attachments = await this.attachmentsService.uploadFiles(
      files.map((f) => ({
        originalname: f.originalname,
        mimetype: f.mimetype,
        size: f.size,
        path: f.path,
      })),
      { source: 'staff' },
    );

    return {
      attachments: attachments.map((a) => ({
        id: a.id,
        fileName: a.fileName,
        mimeType: a.mimeType,
        size: a.size,
      })),
    };
  }

  /**
   * Public upload endpoint (no authentication): up to 5 files, orphan rows.
   * Throttled (anon storage-abuse/DoS). Returns a per-upload `claimToken` that the
   * subsequent public ticket submit / reply must echo back — so a caller cannot
   * adopt orphan attachments uploaded by someone else (IDOR).
   */
  @Post('upload/public')
  @Public()
  @PublicWrite('upload')
  @UseGuards(PublicUploadChallengeGuard)
  @Throttle({ default: { limit: PUBLIC_UPLOAD_LIMIT, ttl: 3_600_000 } })
  @UseInterceptors(FilesInterceptor('files', 5, buildMulterOpts(MULTER_MAX_SIZE_MB)))
  async uploadPublic(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('claimToken') bodyClaimToken?: string,
  ): Promise<{ attachmentIds: number[]; claimToken: string }> {
    if (!files?.length) throw new BadRequestException('No files provided');

    try {
      // The client may supply one token to bind several per-file uploads to a single
      // submit. Accept only a well-formed UUID; otherwise mint our own.
      const claimToken = UUID_RE.test(bodyClaimToken ?? '') ? (bodyClaimToken as string) : randomUUID();
      const attachments = await this.attachmentsService.uploadFiles(
        files.map((f) => ({
          originalname: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
          path: f.path,
        })),
        { claimToken, source: 'public' },
      );

      return { attachmentIds: attachments.map((a) => a.id), claimToken };
    } finally {
      await this.removeQuarantine(files);
    }
  }

  /** Verified-client upload for replies: session + quotas, no CAPTCHA identity challenge. */
  @ClientAuthenticated(ClientUploadAdmissionGuard)
  @Post('upload/client')
  @Throttle({ default: { limit: PUBLIC_UPLOAD_LIMIT, ttl: 3_600_000 } })
  @UseInterceptors(FilesInterceptor('files', 5, buildMulterOpts(MULTER_MAX_SIZE_MB)))
  async uploadClient(
    @UploadedFiles() files: Express.Multer.File[],
    @Body('claimToken') bodyClaimToken?: string,
  ): Promise<{ attachmentIds: number[]; claimToken: string }> {
    if (!files?.length) throw new BadRequestException('No files provided');
    const claimToken = UUID_RE.test(bodyClaimToken ?? '') ? (bodyClaimToken as string) : randomUUID();
    try {
      const attachments = await this.attachmentsService.uploadFiles(
        files.map((f) => ({
          originalname: f.originalname,
          mimetype: f.mimetype,
          size: f.size,
          path: f.path,
        })),
        { claimToken, source: 'client' },
      );
      return { attachmentIds: attachments.map((a) => a.id), claimToken };
    } finally {
      await this.removeQuarantine(files);
    }
  }

  /**
   * Download an attachment by id. Authenticated staff only (TICKET_VIEW) — NOT
   * public: previously any integer id was downloadable with no token (mass IDOR).
   * The link is an <a href> from the staff ticket detail, so the HttpOnly auth
   * cookie is sent automatically on the GET navigation.
   */
  @Get(':id/download')
  @RequirePermissions(PERMISSIONS.TICKET_VIEW)
  async download(@Param('id', ParseIntPipe) id: number, @Res() res: Response): Promise<void> {
    const attachment = await this.attachmentsService.getAttachmentOrThrow(id);
    this.streamAttachment(res, attachment);
  }

  /**
   * Owner-scoped client download (GOAL_PUBLIC_SECURITY S2-8). Separate from the staff
   * route: requires a verified client session and that the attachment belongs to a
   * non-third-party POST on a ticket the client owns. Wrong owner/id → same 404. The
   * `<a href>` navigation carries the HttpOnly th_client cookie automatically.
   */
  @ClientAuthenticated()
  @Get('client/:id/download')
  async clientDownload(
    @Param('id', ParseIntPipe) id: number,
    @CurrentClient() client: ClientPrincipal,
    @Res() res: Response,
  ): Promise<void> {
    const attachment = await this.attachmentsService.getClientDownloadableOrThrow(id, client.userId);
    this.streamAttachment(res, attachment);
  }

  /** Shared attachment streaming (staff + client download). */
  private streamAttachment(res: Response, attachment: Attachment): void {
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', attachment.size);

    const stream = this.storageService.createReadStream(attachment.storageKey);
    stream.on('error', (err) => {
      this.logger.error(`Stream error for attachment ${attachment.id}: ${String(err)}`);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    stream.pipe(res);
  }

  private async removeQuarantine(files: Express.Multer.File[] | undefined): Promise<void> {
    await Promise.all((files ?? []).map((file) => fs.unlink(file.path).catch(() => undefined)));
  }
}
