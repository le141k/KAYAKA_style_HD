import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Attachment, Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { ClamAvService } from '../../security/clamav.service';
import { AttachmentCapacityService } from '../../security/attachment-capacity.service';
import { StorageService } from './storage.service';
import { verifyFileSignature, isExtensionAllowed } from './file-signature.util';

export interface UploadFileInput {
  originalname: string;
  mimetype: string;
  size: number;
  buffer?: Buffer;
  /** Quarantine path written by Multer; preferred for bounded-memory HTTP uploads. */
  path?: string;
}

export type AttachmentSource = 'staff' | 'public' | 'client' | 'inbound' | 'internal';

function isZipContainer(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  );
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
    @Optional() private readonly scanner?: ClamAvService,
    @Optional() private readonly capacity?: AttachmentCapacityService,
  ) {}

  /**
   * Persist one or more uploaded files.
   * ticketId / postId are optional — use linkToPost() to bind orphan rows later.
   */
  async uploadFiles(
    files: UploadFileInput[],
    ctx: {
      ticketId?: number;
      postId?: number;
      claimToken?: string;
      source?: AttachmentSource;
    } = {},
  ): Promise<Attachment[]> {
    const source = ctx.source ?? 'internal';
    const maxFiles = source === 'public' || source === 'client' ? 5 : 10;
    const perFileLimit = (this.config?.TELECOM_HD_UPLOAD_MAX_SIZE_MB ?? 25) * 1024 * 1024;
    const totalLimit = (this.config?.TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB ?? 50) * 1024 * 1024;
    if (files.length === 0 || files.length > maxFiles) {
      throw new BadRequestException(`At most ${maxFiles} attachments are allowed`);
    }
    if (this.config?.NODE_ENV === 'production' && !this.capacity) {
      throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
    }
    const adoptedStorageKeys: string[] = [];

    try {
      const actualSizes = await Promise.all(files.map((file) => this.actualSize(file)));
      const totalBytes = actualSizes.reduce((sum, size) => sum + size, 0);
      const bytesNotYetOnDisk = files.reduce(
        (sum, file, index) => sum + (file.path ? 0 : actualSizes[index]!),
        0,
      );
      if (actualSizes.some((size) => size > perFileLimit) || totalBytes > totalLimit) {
        throw new BadRequestException('Attachment size limit exceeded');
      }
      const isOrphanUpload = ctx.ticketId === undefined && ctx.postId === undefined;
      if (this.capacity) {
        if (isOrphanUpload) {
          await this.capacity.assertCanAccept(totalBytes, files.length, bytesNotYetOnDisk);
        } else {
          await this.capacity.assertDiskSpace(bytesNotYetOnDisk);
        }
      }

      // Validate and scan every input before adopting any file. A later bad file
      // therefore cannot leave an earlier file temporarily downloadable.
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!;
        if (file.originalname.length > 255 || hasControlCharacters(file.originalname)) {
          throw new BadRequestException('Attachment filename is invalid');
        }
        // Defence-in-depth: refuse executable/script extensions outright — a script
        // sent as text/plain passes the MIME + magic-byte checks (looksTextual), so
        // the extension denylist is the layer that stops it being stored at all.
        if (!isExtensionAllowed(file.originalname)) {
          throw new BadRequestException(
            `File ${file.originalname} has a blocked file type and cannot be uploaded`,
          );
        }

        const quarantinePath = await this.materializeQuarantine(file);
        const prefix = await this.readPrefix(quarantinePath, 4096);

        // Archive policy: ZIP and ZIP-based OOXML are disabled for every channel.
        // This is byte-based (not the spoofable MIME header), so encrypted/nested
        // archives and decompression bombs never reach adoption or download.
        if (isZipContainer(prefix)) {
          throw new BadRequestException('Archive containers are not accepted');
        }

        // Verify the actual bytes match the declared MIME — the Multer filter only
        // checks the spoofable Content-Type header.
        if (!verifyFileSignature(file.mimetype, prefix)) {
          throw new BadRequestException(
            `File ${file.originalname} content does not match its declared type (${file.mimetype})`,
          );
        }

        if (!this.scanner && this.config?.NODE_ENV === 'production') {
          throw new ServiceUnavailableException('Attachment scanner is unavailable');
        }
        await this.scanner?.scanFile(quarantinePath);
      }

      const persist = async (tx: Prisma.TransactionClient): Promise<Attachment[]> => {
        const results: Attachment[] = [];
        const subdir = ctx.ticketId ? `tickets/${ctx.ticketId}` : 'orphan';
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]!;
          const { storageKey, sha1 } = await this.storageService.adoptQuarantined(
            subdir,
            file.originalname,
            file.path!,
          );
          adoptedStorageKeys.push(storageKey);
          const attachment = await tx.attachment.create({
            data: {
              ticketId: ctx.ticketId ?? null,
              postId: ctx.postId ?? null,
              fileName: file.originalname,
              mimeType: file.mimetype,
              size: actualSizes[index]!,
              sha1,
              storageKey,
              claimToken: ctx.claimToken ?? null,
            },
          });
          results.push(attachment);
          this.logger.debug(`Uploaded attachment ${attachment.id}`);
        }
        return results;
      };

      if (isOrphanUpload && this.capacity) {
        return await this.capacity.withOrphanCapacity(totalBytes, files.length, persist);
      }
      // The validated bytes are already in quarantine on the upload filesystem.
      // Recheck that the reserve still holds without charging the payload twice.
      if (this.capacity) await this.capacity.assertDiskSpace(0);
      return await this.prisma.$transaction(persist, { timeout: 120_000 });
    } catch (err) {
      // DB rows roll back together; remove each permanent file adopted before failure.
      for (const storageKey of adoptedStorageKeys.reverse()) {
        await this.storageService.delete(storageKey).catch(() => undefined);
      }
      throw err;
    } finally {
      await Promise.all(
        files
          .map((file) => file.path)
          .filter((path): path is string => Boolean(path))
          .map((path) => fs.unlink(path).catch(() => undefined)),
      );
    }
  }

  private async actualSize(file: UploadFileInput): Promise<number> {
    if (file.path) return (await fs.stat(file.path)).size;
    if (file.buffer) return file.buffer.length;
    throw new BadRequestException('Attachment bytes are missing');
  }

  private async materializeQuarantine(file: UploadFileInput): Promise<string> {
    if (file.path) return file.path;
    if (!file.buffer) throw new BadRequestException('Attachment bytes are missing');
    const root = this.config?.TELECOM_HD_UPLOAD_DIR ?? '/tmp';
    const dir = join(root, 'quarantine');
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, `${randomUUID()}.upload`);
    await fs.writeFile(path, file.buffer, { mode: 0o600 });
    file.path = path;
    return path;
  }

  private async readPrefix(path: string, length: number): Promise<Buffer> {
    const handle = await fs.open(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
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
  async linkToPost(
    ids: number[],
    postId: number,
    ticketId: number,
    claimToken?: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!ids.length) return;
    const uniqueIds = [...new Set(ids)];

    const adopt = async (tx: Prisma.TransactionClient) => {
      const adopted = await tx.attachment.updateMany({
        where: {
          id: { in: uniqueIds },
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
      if (adopted.count !== uniqueIds.length) {
        throw new BadRequestException('One or more attachments cannot be adopted');
      }
    };
    if (transaction) await adopt(transaction);
    else await this.prisma.$transaction(adopt);
  }

  /**
   * Link orphan attachment rows to a specific internal note and ticket.
   * Mirrors linkToPost — used by TicketsService.addNote when attachmentIds are supplied.
   * Only staff-authenticated callers reach this path; no claimToken is needed.
   */
  async linkToNote(
    ids: number[],
    noteId: number,
    ticketId: number,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    if (!ids.length) return;
    const uniqueIds = [...new Set(ids)];

    const adopt = async (tx: Prisma.TransactionClient) => {
      const adopted = await tx.attachment.updateMany({
        where: {
          id: { in: uniqueIds },
          postId: null, // only adopt orphans (not already linked to a post)
          noteId: null, // not already linked to another note
        },
        data: {
          noteId,
          ticketId,
          claimToken: null,
        },
      });
      if (adopted.count !== uniqueIds.length) {
        throw new BadRequestException('One or more attachments cannot be adopted');
      }
    };
    if (transaction) await adopt(transaction);
    else await this.prisma.$transaction(adopt);
  }

  async getAttachmentOrThrow(id: number): Promise<Attachment> {
    const attachment = await this.prisma.attachment.findUnique({ where: { id } });
    if (!attachment) throw new NotFoundException(`Attachment ${id} not found`);
    return attachment;
  }

  /**
   * Fetch an attachment ONLY if the verified client owns the ticket it belongs to, per
   * the client-download rules (GOAL_PUBLIC_SECURITY S2-8): it must be a POST attachment
   * (not a ticket-level orphan and not an internal-note attachment), the post must not be
   * third-party, and the post's ticket must be owned by `clientUserId`. Any failure —
   * wrong owner, wrong/missing id, third-party, note, unmapped — returns the SAME 404,
   * so the route neither enumerates ids nor leaks other customers' files.
   */
  async getClientDownloadableOrThrow(id: number, clientUserId: number): Promise<Attachment> {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id },
      include: { post: { select: { isThirdParty: true, ticket: { select: { userId: true } } } } },
    });
    if (
      !attachment ||
      attachment.postId === null ||
      attachment.noteId !== null ||
      !attachment.post ||
      attachment.post.isThirdParty ||
      attachment.post.ticket.userId !== clientUserId
    ) {
      throw new NotFoundException(`Attachment ${id} not found`);
    }
    return attachment;
  }

  async deleteAttachment(id: number): Promise<void> {
    const attachment = await this.getAttachmentOrThrow(id);
    await this.prisma.attachment.delete({ where: { id } });
    try {
      await this.storageService.delete(attachment.storageKey);
    } catch {
      // Prefer an untracked file (caught by reconciliation) over a live DB row
      // whose bytes were already deleted after a failed database operation.
      this.logger.error('Attachment row deleted but its file could not be removed');
    }
  }
}
