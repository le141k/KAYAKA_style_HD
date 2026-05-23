import {
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  ParseIntPipe,
  Post,
  Res,
  UploadedFiles,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { Public, RequirePermissions } from '../../auth/auth.decorators';
import { PERMISSIONS } from '../../auth/permissions';
import { AttachmentsService } from './attachments.service';
import { StorageService } from './storage.service';

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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/zip',
  'application/octet-stream',
]);

function buildMulterOpts(maxSizeMb: number) {
  return {
    storage: memoryStorage(),
    limits: { fileSize: maxSizeMb * 1024 * 1024 },
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
  @UseInterceptors(
    FilesInterceptor(
      'files',
      10,
      buildMulterOpts(25), // will be overridden per-request via interceptor factory below
    ),
  )
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
        buffer: f.buffer,
      })),
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

  /** Public upload endpoint (no authentication): up to 5 files, orphan rows. */
  @Post('upload/public')
  @Public()
  @UseInterceptors(FilesInterceptor('files', 5, buildMulterOpts(25)))
  async uploadPublic(@UploadedFiles() files: Express.Multer.File[]): Promise<{ attachmentIds: number[] }> {
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
        buffer: f.buffer,
      })),
    );

    return { attachmentIds: attachments.map((a) => a.id) };
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

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(attachment.fileName)}"`);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', attachment.size);

    const stream = this.storageService.createReadStream(attachment.storageKey);
    stream.on('error', (err) => {
      this.logger.error(`Stream error for attachment ${id}: ${String(err)}`);
      if (!res.headersSent) {
        res.status(500).end();
      }
    });
    stream.pipe(res);
  }
}
