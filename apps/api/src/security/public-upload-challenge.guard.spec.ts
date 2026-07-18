import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { PublicUploadChallengeGuard } from './public-upload-challenge.guard';

function context(headers: Record<string, string> = {}) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, ip: '203.0.113.4' }),
    }),
  } as never;
}

describe('PublicUploadChallengeGuard', () => {
  it('returns 404 before challenge validation when public upload is closed', async () => {
    const turnstile = { verify: vi.fn() };
    const admission = {
      validateContentLength: vi.fn(() => {
        throw new NotFoundException();
      }),
      reserve: vi.fn(),
    };
    const guard = new PublicUploadChallengeGuard(turnstile as never, admission as never);

    await expect(guard.canActivate(context())).rejects.toThrow(NotFoundException);
    expect(turnstile.verify).not.toHaveBeenCalled();
  });

  it('validates the action-bound header before reserving an upload request', async () => {
    const order: string[] = [];
    const turnstile = {
      verify: vi.fn().mockImplementation(async () => {
        order.push('challenge');
      }),
    };
    const admission = {
      validateContentLength: vi.fn(() => 4096),
      reserve: vi.fn().mockImplementation(async () => {
        order.push('quota');
      }),
    };
    const guard = new PublicUploadChallengeGuard(turnstile as never, admission as never);

    await expect(
      guard.canActivate(context({ 'x-turnstile-token': 'single-use-token', 'content-length': '4096' })),
    ).resolves.toBe(true);
    expect(turnstile.verify).toHaveBeenCalledWith('single-use-token', 'public-upload', '203.0.113.4');
    expect(admission.validateContentLength).toHaveBeenCalledWith(expect.any(Object), 'public');
    expect(admission.reserve).toHaveBeenCalledWith(expect.any(Object), 4096, 'public');
    expect(order).toEqual(['challenge', 'quota']);
  });

  it('does not reach Multer when the pre-Multer reservation rejects', async () => {
    const turnstile = { verify: vi.fn().mockResolvedValue(undefined) };
    const admission = {
      validateContentLength: vi.fn(() => 4096),
      reserve: vi.fn().mockRejectedValue(new Error('quota rejected')),
    };
    const multerInterceptor = vi.fn();
    const guard = new PublicUploadChallengeGuard(turnstile as never, admission as never);

    await expect(
      guard
        .canActivate(context({ 'x-turnstile-token': 'ok', 'content-length': '4096' }))
        .then(multerInterceptor),
    ).rejects.toThrow('quota rejected');
    expect(multerInterceptor).not.toHaveBeenCalled();
  });
});
