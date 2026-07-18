import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AttachmentsService } from './attachments.service';
import type { StorageService } from './storage.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { Attachment } from '@prisma/client';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
  const db = {
    attachment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
  };
  return {
    ...db,
    $transaction: vi.fn((callback: (tx: typeof db) => unknown) => callback(db)),
  } as unknown as PrismaService;
}

function makeStorageMock() {
  return {
    write: vi.fn().mockResolvedValue({ storageKey: 'orphan/uuid-test.pdf', sha1: 'abc123' }),
    adoptQuarantined: vi.fn().mockResolvedValue({ storageKey: 'orphan/uuid-test.pdf', sha1: 'abc123' }),
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
      (storage.adoptQuarantined as ReturnType<typeof vi.fn>).mockResolvedValue({
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

      expect(storage.adoptQuarantined).toHaveBeenCalledWith('orphan', 'test.pdf', expect.any(String));
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
      (storage.adoptQuarantined as ReturnType<typeof vi.fn>).mockResolvedValue({
        storageKey: 'tickets/42/uuid-file.txt',
        sha1: 'sha1hash',
      });
      (prisma.attachment.create as ReturnType<typeof vi.fn>).mockResolvedValue(mockAttachment);

      await service.uploadFiles(
        [{ originalname: 'file.txt', mimetype: 'text/plain', size: 100, buffer: Buffer.from('text') }],
        { ticketId: 42 },
      );

      expect(storage.adoptQuarantined).toHaveBeenCalledWith('tickets/42', 'file.txt', expect.any(String));
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

    // D6 — a script with textual content sent as text/plain passes the MIME +
    // magic-byte checks; the extension denylist must still refuse it.
    it('rejects a blocked extension even when content is textual (D6)', async () => {
      await expect(
        service.uploadFiles([
          {
            originalname: 'shell.php',
            mimetype: 'text/plain',
            size: 30,
            buffer: Buffer.from('<?php system($_GET["c"]); ?>'),
          },
        ]),
      ).rejects.toThrow(/blocked file type/);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('rejects control characters in attachment filenames', async () => {
      await expect(
        service.uploadFiles([
          {
            originalname: 'invoice\n.pdf',
            mimetype: 'application/pdf',
            size: 8,
            buffer: Buffer.from('%PDF-1.7'),
          },
        ]),
      ).rejects.toThrow(/filename is invalid/);
      expect(storage.adoptQuarantined).not.toHaveBeenCalled();
    });

    it('rejects a .sh disguised as text/plain (D6)', async () => {
      await expect(
        service.uploadFiles([
          { originalname: 'pwn.sh', mimetype: 'text/plain', size: 10, buffer: Buffer.from('rm -rf /') },
        ]),
      ).rejects.toThrow(/blocked file type/);
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('rejects ZIP archives by bytes before adoption', async () => {
      await expect(
        service.uploadFiles(
          [
            {
              originalname: 'archive.zip',
              mimetype: 'application/zip',
              size: 4,
              buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
            },
          ],
          { source: 'public' },
        ),
      ).rejects.toThrow(/Archive containers/);
      expect(storage.adoptQuarantined).not.toHaveBeenCalled();
    });

    it('rejects a ZIP container disguised as an OOXML document', async () => {
      await expect(
        service.uploadFiles([
          {
            originalname: 'invoice.docx',
            mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 4,
            buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
          },
        ]),
      ).rejects.toThrow(/Archive containers/);
      expect(storage.adoptQuarantined).not.toHaveBeenCalled();
    });

    it('enforces the service-boundary file-count limit', async () => {
      const file = {
        originalname: 'a.txt',
        mimetype: 'text/plain',
        size: 1,
        buffer: Buffer.from('a'),
      };
      await expect(
        service.uploadFiles(
          Array.from({ length: 6 }, () => ({ ...file })),
          { source: 'public' },
        ),
      ).rejects.toThrow(/At most 5/);
    });

    it('enforces shared orphan capacity before materializing or adopting bytes', async () => {
      const capacity = {
        assertCanAccept: vi.fn().mockRejectedValue(new Error('capacity closed')),
        assertDiskSpace: vi.fn(),
        withOrphanCapacity: vi.fn(),
      };
      service = new AttachmentsService(
        prisma as unknown as PrismaService,
        storage as unknown as StorageService,
        undefined,
        undefined,
        capacity as never,
      );

      await expect(
        service.uploadFiles(
          [{ originalname: 'a.pdf', mimetype: 'application/pdf', size: 8, buffer: Buffer.from('%PDF-1.7') }],
          { source: 'public' },
        ),
      ).rejects.toThrow('capacity closed');
      expect(capacity.assertCanAccept).toHaveBeenCalledWith(8, 1, 8);
      expect(storage.adoptQuarantined).not.toHaveBeenCalled();
      expect(prisma.attachment.create).not.toHaveBeenCalled();
    });

    it('does not reserve disk twice for bytes already written to quarantine', async () => {
      const capacity = {
        assertCanAccept: vi.fn().mockRejectedValue(new Error('capacity closed')),
        assertDiskSpace: vi.fn(),
        withOrphanCapacity: vi.fn(),
      };
      const path = join(tmpdir(), `attachment-quarantine-${randomUUID()}.upload`);
      await writeFile(path, '%PDF-1.7');
      service = new AttachmentsService(
        prisma as unknown as PrismaService,
        storage as unknown as StorageService,
        undefined,
        undefined,
        capacity as never,
      );

      await expect(
        service.uploadFiles([{ originalname: 'a.pdf', mimetype: 'application/pdf', size: 8, path }], {
          source: 'public',
        }),
      ).rejects.toThrow('capacity closed');

      expect(capacity.assertCanAccept).toHaveBeenCalledWith(8, 1, 0);
    });

    it('fails closed in production when the shared capacity gate is unavailable', async () => {
      service = new AttachmentsService(
        prisma as unknown as PrismaService,
        storage as unknown as StorageService,
        { NODE_ENV: 'production' } as never,
        { scanFile: vi.fn() } as never,
      );

      await expect(
        service.uploadFiles([
          {
            originalname: 'a.pdf',
            mimetype: 'application/pdf',
            size: 8,
            buffer: Buffer.from('%PDF-1.7'),
          },
        ]),
      ).rejects.toThrow(/temporarily unavailable/);
      expect(storage.adoptQuarantined).not.toHaveBeenCalled();
    });

    it('rechecks orphan capacity under the transaction lock before adoption', async () => {
      const capacity = {
        assertCanAccept: vi.fn().mockResolvedValue(undefined),
        assertDiskSpace: vi.fn(),
        withOrphanCapacity: vi.fn((_bytes: number, _count: number, operation: (tx: unknown) => unknown) =>
          operation(prisma as unknown),
        ),
      };
      (prisma.attachment.create as ReturnType<typeof vi.fn>).mockResolvedValue(makeAttachment());
      service = new AttachmentsService(
        prisma as unknown as PrismaService,
        storage as unknown as StorageService,
        undefined,
        undefined,
        capacity as never,
      );

      await service.uploadFiles(
        [{ originalname: 'a.pdf', mimetype: 'application/pdf', size: 8, buffer: Buffer.from('%PDF-1.7') }],
        { source: 'public' },
      );

      expect(capacity.withOrphanCapacity).toHaveBeenCalledWith(8, 1, expect.any(Function));
      expect(storage.adoptQuarantined).toHaveBeenCalledOnce();
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
      (prisma.attachment.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      await service.linkToPost([1, 2], 99, 10, 'tok-abc');

      // The where MUST include the per-upload secret so a public submitter cannot
      // adopt another submitter's orphan attachment by guessing ids (IDOR).
      expect(prisma.attachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2] }, postId: null, claimToken: 'tok-abc' },
        data: { postId: 99, ticketId: 10, claimToken: null },
      });
    });

    it('rolls back and rejects partial anonymous adoption', async () => {
      (prisma.attachment.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await expect(service.linkToPost([1, 2], 99, 10, 'tok-abc')).rejects.toThrow(/cannot be adopted/);
    });

    it('uses a supplied parent transaction without opening a nested transaction', async () => {
      const tx = {
        attachment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };

      await service.linkToPost([1], 99, 10, 'tok-abc', tx as never);

      expect(tx.attachment.updateMany).toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is a no-op when ids array is empty', async () => {
      await service.linkToPost([], 99, 10);
      expect(prisma.attachment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('linkToNote', () => {
    it('uses a supplied parent transaction without opening a nested transaction', async () => {
      const tx = {
        attachment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };

      await service.linkToNote([1], 55, 10, tx as never);

      expect(tx.attachment.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [1] }, postId: null, noteId: null },
        data: { noteId: 55, ticketId: 10, claimToken: null },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects partial adoption', async () => {
      (prisma.attachment.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

      await expect(service.linkToNote([1, 2], 55, 10)).rejects.toThrow(/cannot be adopted/);
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

  // ─── getClientDownloadableOrThrow (S2-8) ───────────────────────────────────

  describe('getClientDownloadableOrThrow', () => {
    const OWNER = 5;
    // A post attachment on a non-third-party post owned by user 5.
    function ownedAttachment(over: Record<string, unknown> = {}) {
      return {
        ...makeAttachment({ id: 3, postId: 10, ticketId: 1 }),
        post: { isThirdParty: false, ticket: { userId: OWNER } },
        ...over,
      };
    }

    it('returns the attachment for the owning client', async () => {
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ownedAttachment());
      const result = await service.getClientDownloadableOrThrow(3, OWNER);
      expect(result.id).toBe(3);
    });

    it('404s for a different client (wrong owner)', async () => {
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(ownedAttachment());
      await expect(service.getClientDownloadableOrThrow(3, 999)).rejects.toThrow(NotFoundException);
    });

    it('404s for a third-party post attachment', async () => {
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        ownedAttachment({ post: { isThirdParty: true, ticket: { userId: OWNER } } }),
      );
      await expect(service.getClientDownloadableOrThrow(3, OWNER)).rejects.toThrow(NotFoundException);
    });

    it('404s for an internal-note attachment (noteId set)', async () => {
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        ownedAttachment({ noteId: 7 }),
      );
      await expect(service.getClientDownloadableOrThrow(3, OWNER)).rejects.toThrow(NotFoundException);
    });

    it('404s for a ticket-level orphan (no post)', async () => {
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(
        ownedAttachment({ postId: null, post: null }),
      );
      await expect(service.getClientDownloadableOrThrow(3, OWNER)).rejects.toThrow(NotFoundException);
    });

    it('404s when the attachment does not exist', async () => {
      (prisma.attachment.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(service.getClientDownloadableOrThrow(999, OWNER)).rejects.toThrow(NotFoundException);
    });
  });
});
