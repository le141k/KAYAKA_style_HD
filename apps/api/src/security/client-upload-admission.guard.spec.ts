import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ClientUploadAdmissionGuard } from './client-upload-admission.guard';

function context(client?: { userId: number }) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers: { 'content-length': '2048' },
        ip: '203.0.113.10',
        client,
      }),
    }),
  } as never;
}

describe('ClientUploadAdmissionGuard', () => {
  it('preserves verified-client authentication before reservation', async () => {
    const admission = { validateContentLength: vi.fn(), reserve: vi.fn() };
    const guard = new ClientUploadAdmissionGuard(admission as never);

    await expect(guard.canActivate(context())).rejects.toThrow(UnauthorizedException);
    expect(admission.validateContentLength).not.toHaveBeenCalled();
  });

  it('reserves the verified client identity before Multer', async () => {
    const admission = {
      validateContentLength: vi.fn().mockReturnValue(2048),
      reserve: vi.fn().mockResolvedValue(undefined),
    };
    const guard = new ClientUploadAdmissionGuard(admission as never);

    await expect(guard.canActivate(context({ userId: 42 }))).resolves.toBe(true);
    expect(admission.validateContentLength).toHaveBeenCalledWith(expect.any(Object), 'client');
    expect(admission.reserve).toHaveBeenCalledWith(expect.any(Object), 2048, 'client', '42');
  });
});
