import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Attachment } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from './storage.service';

export interface UploadFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  /**
   * Persist one or more uploaded files.
   * ticketId / postId are optional — use linkToPost() to bind orphan rows later.
   */
  async uploadFiles(
    files: UploadFileInput[],
    ctx: { ticketId?: number; postId?: number } = {},
  ): Promise<Attachment[]> {
    // TODO (P1): ClamAV scan
    const results: Attachment[] = [];

    for (const file of files) {
      const subdir = ctx.ticketId ? `tickets/${ctx.ticketId}` : 'orphan';
      const { storageKey, sha1 } = await this.storageService.write(subdir, file.originalname, file.buffer);

      const attachment = await this.prisma.attachment.create({
        data: {
          ticketId: ctx.ticketId ?? null,
          postId: ctx.postId ?? null,
          fileName: file.originalname,
          mimeType: file.mimetype,
          size: file.size,
          sha1,
          storageKey,
        },
      });

      results.push(attachment);
      this.logger.debug(`Uploaded attachment ${attachment.id}: ${file.originalname}`);
    }

    return results;
  }

  /**
   * Link orphan attachment rows (postId IS NULL) to a specific post and ticket.
   * Called after the post is created, with the ids the client sent back.
   */
  async linkToPost(ids: number[], postId: number, ticketId: number): Promise<void> {
    if (!ids.length) return;

    await this.prisma.attachment.updateMany({
      where: {
        id: { in: ids },
        postId: null, // only adopt orphans
      },
      data: {
        postId,
        ticketId,
      },
    });
  }

  async getAttachmentOrThrow(id: number): Promise<Attachment> {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    return attachment;
  }

  async deleteAttachment(id: number): Promise<void> {
    const attachment = await this.getAttachmentOrThrow(id);
    await this.storageService.delete(attachment.storageKey);
    await this.prisma.attachment.delete({ where: { id } });
  }
}
