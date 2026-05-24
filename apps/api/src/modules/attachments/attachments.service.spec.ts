import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import type { StorageService } from './storage.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Attachment } from '@prisma/client';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: 1,
    ticketId: null,
    postId: null,
    noteId: null,
    fileName: 'test.pdf',
    mimeType: 'application/pdf',
    size: 1024,
    sha1: 'abc123',
    storageKey: 'orphan/uuid-test.pdf',
    claimToken: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function makePrismaMock() {
  return {
    attachment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService;
}

function makeStorageMock() {
  return {
    write: vi.fn().mockResolvedValue({ storageKey: 'orphan/uuid-test.pdf', sha1: 'abc123' }),
    createReadStream: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as StorageService;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('AttachmentsService', () => {
  let service: AttachmentsService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let storage: ReturnType<typeof makeStorageMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    storage = makeStorageMock();
    service = new AttachmentsService(
      prisma as unknown as PrismaService,
      storage as unknown as StorageService,
    );
  });

  // ─── uploadFiles ───────────────────────────────────────────────────────────

  describe('uploadFiles', () => {
    it('writes buffer to storage and creates DB row', async () => {
      const mockAttachment = makeAttachment({ id: 5 });
      (storage.write as ReturnType<typeof vi.fn>).mockResolvedValue({
        storageKey: 'orphan/uuid-test.pdf',
        sha1: 'abc123',
      });
      (prisma.attachment.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockAttachment);

      const result = await service.uploadFiles([
        {
          originalname: 'test.pdf',
          mimetype: 'application/pdf',
          size: 1024,
          buffer: Buffer.from('%PDF-1.4 content'),
        },
      ]);

      expect(storage.write).toHaveBeenCalledWith('orphan', 'test.pdf', expect.any(Buffer));
      expect(prisma.attachment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fileName: 'test.pdf',
            mimeType: 'application/pdf',
            sha1: 'abc123',
          }),
        }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe(5);
    });

    it('uses ticketId in subdir when provided', async () => {
      const mockAttachment = makeAttachment({ ticketId: 42 });
      (storage.write as ReturnType<typeof vi.fn>).mockResolvedValue({
        storageKey: 'tickets/42/uuid-file.txt',
        sha1: 'sha1hash',
      });
      (prisma.attachment.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockAttachment);

      await service.uploadFiles(
        [{ originalname: 'file.txt', mimetype: 'text/plain', size: 100, buffer: Buffer.from('text') }],
        { ticketId: 42 },
      );

      expect(storage.write).toHaveBeenCalledWith('tickets/42', 'file.txt', expect.any(Buffer));
    });

    it('SEC-6: persists the claimToken on anonymous orphan uploads', async () => {
      (prisma.attachment.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeAttachment());

      await service.uploadFiles(
        [{ originalname: 'a.pdf', mimetype: 'application/pdf', size: 10, buffer: Buffer.from('%PDF-1.7') }],
        { claimToken: 'tok-xyz' },
      );

      expect(prisma.attachment.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ claimToken: 'tok-xyz' }) }),
      );
    });

    it('rejects a file whose bytes do not match the declared MIME (spoof guard)', async () => {
      await expect(
        service.uploadFiles([
          {
            originalname: 'evil.pdf',
            mimetype: 'application/pdf',
            size: 20,
            // Declares PDF but the bytes are an ELF executable header.
            buffer: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
          },
        ]),
      ).rejects.toThrow(/does not match its declared type/);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });
  });

  // ─── linkToPost ────────────────────────────────────────────────────────────

  describe('linkToPost', () => {
    it('updates orphan attachments with postId and ticketId (staff path: no token scope)', async () => {
      (prisma.attachment.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      await service.linkToPost([1, 2], 99, 10);

      expect(prisma.attachment.updateMany).toHaveBeenCalledWith({
        // No claimToken in the where → authenticated callers adopt by id+orphan only.
        where: { id: { in: [1, 2] }, postId: null },
        // Token is always cleared on adoption so it can't be replayed.
        data: { postId: 99, ticketId: 10, claimToken: null },
      });
    });

    it('SEC-6: scopes orphan adoption to the matching claimToken (anon path)', async () => {
      (prisma.attachment.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await service.linkToPost([1, 2], 99, 10, 'tok-abc');

      // The where MUST include the per-upload secret so a public submitter cannot
      // adopt another submitter's orphan attachment by guessing ids (IDOR).
      expect(prisma.attachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2] }, postId: null, claimToken: 'tok-abc' },
        data: { postId: 99, ticketId: 10, claimToken: null },
      });
    });

    it('is a no-op when ids array is empty', async () => {
      await service.linkToPost([], 99, 10);
      expect(prisma.attachment.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── getAttachmentOrThrow ──────────────────────────────────────────────────

  describe('getAttachmentOrThrow', () => {
    it('returns attachment when found', async () => {
      const attachment = makeAttachment({ id: 7 });
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(attachment);

      const result = await service.getAttachmentOrThrow(7);
      expect(result.id).toBe(7);
    });

    it('throws NotFoundException when not found', async () => {
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.getAttachmentOrThrow(999)).rejects.toThrow(NotFoundException);
    });
  });
});
