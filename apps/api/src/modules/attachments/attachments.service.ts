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
    ctx: { ticketId?: number; postId?: number; claimToken?: string } = {},
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
          claimToken: ctx.claimToken ?? null,
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
   *
   * For ANONYMOUS uploads, pass the `claimToken` returned by the public upload:
   * adoption is then scoped to orphans bearing that exact token, so a public
   * submitter cannot adopt another submitter's orphan by guessing ids (IDOR).
   * The token is cleared on adoption so it cannot be replayed. Authenticated
   * staff callers omit the token (the route guard already scopes them).
   */
  async linkToPost(ids: number[], postId: number, ticketId: number, claimToken?: string): Promise<void> {
    if (!ids.length) return;

    await this.prisma.attachment.updateMany({
      where: {
        id: { in: ids },
        postId: null, // only adopt orphans
        // Anonymous path: require the matching per-upload secret.
        ...(claimToken ? { claimToken } : {}),
      },
      data: {
        postId,
        ticketId,
        claimToken: null, // consume the token so it can't be replayed
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
