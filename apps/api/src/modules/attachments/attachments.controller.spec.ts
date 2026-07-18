import 'reflect-metadata';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AttachmentsController } from './attachments.controller';
import type { AttachmentsService } from './attachments.service';
import type { StorageService } from './storage.service';
import type { AppConfig } from '../../config/configuration';
import type { Attachment } from '@prisma/client';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ClientPortalGuard } from '../../auth/client-portal.guard';
import { ClientAuthGuard } from '../client-auth/client-auth.guard';
import { ClientUploadAdmissionGuard } from '../../security/client-upload-admission.guard';

function makeFile(name = 'a.pdf'): Express.Multer.File {
  return {
    originalname: name,
    mimetype: 'application/pdf',
    size: 10,
    buffer: Buffer.from('x'),
    path: '/tmp/nonexistent-upload-test',
  } as unknown as Express.Multer.File;
}

function makeAttachment(id: number): Attachment {
  return {
    id,
    ticketId: null,
    postId: null,
    noteId: null,
    fileName: 'a.pdf',
    mimeType: 'application/pdf',
    size: 10,
    sha1: 'h',
    storageKey: 'orphan/a.pdf',
    claimToken: null,
    createdAt: new Date(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('AttachmentsController — public upload', () => {
  let controller: AttachmentsController;
  let service: { uploadFiles: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    service = { uploadFiles: vi.fn().mockResolvedValue([makeAttachment(1), makeAttachment(2)]) };
    const storage = {} as unknown as StorageService;
    const config = { TELECOM_HD_UPLOAD_MAX_SIZE_MB: 25 } as unknown as AppConfig;
    controller = new AttachmentsController(service as unknown as AttachmentsService, storage, config);
  });

  it('SEC-5: the public upload route is throttled (anon storage-abuse guard)', () => {
    // @Throttle({...}) records a per-named-throttler metadata key on the method.
    const keys = Reflect.getMetadataKeys(controller.uploadPublic) as string[];
    expect(keys.some((k) => String(k).startsWith('THROTTLER:LIMIT'))).toBe(true);
  });

  it('runs verified-client auth and admission guards before the upload interceptor', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, controller.uploadClient) as unknown[];
    expect(guards).toEqual([ClientPortalGuard, ClientAuthGuard, ClientUploadAdmissionGuard]);
  });

  it('marks verified-client uploads with the stricter five-file service policy', async () => {
    const token = '11111111-2222-3333-4444-555555555555';

    await controller.uploadClient([makeFile()], token);

    expect(service.uploadFiles).toHaveBeenCalledWith(expect.any(Array), {
      claimToken: token,
      source: 'client',
    });
  });

  it('SEC-6: forwards a client-supplied UUID claimToken to uploadFiles and echoes it back', async () => {
    const token = '11111111-2222-3333-4444-555555555555';
    const res = await controller.uploadPublic([makeFile()], token);

    expect(service.uploadFiles).toHaveBeenCalledWith(expect.any(Array), {
      claimToken: token,
      source: 'public',
    });
    expect(res.claimToken).toBe(token);
    expect(res.attachmentIds).toEqual([1, 2]);
  });

  it('SEC-6: mints a fresh UUID claimToken when none (or a malformed one) is supplied', async () => {
    const res = await controller.uploadPublic([makeFile()], 'not-a-uuid');

    const passed = service.uploadFiles.mock.calls[0]![1] as { claimToken: string };
    expect(UUID_RE.test(passed.claimToken)).toBe(true);
    expect(res.claimToken).toBe(passed.claimToken);
  });
});
