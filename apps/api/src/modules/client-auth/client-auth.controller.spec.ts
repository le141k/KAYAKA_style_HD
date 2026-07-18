import { describe, expect, it, vi } from 'vitest';
import { ClientAuthController } from './client-auth.controller';
import type { AppConfig } from '../../config/configuration';

describe('ClientAuthController request-link anti-enumeration', () => {
  it('returns the generic 202 shape after quota checks without awaiting dispatch', async () => {
    const clientAuth = { queueRequestLink: vi.fn() };
    const turnstile = { verify: vi.fn().mockResolvedValue(undefined) };
    const abuseQuota = { consume: vi.fn().mockResolvedValue(undefined) };
    const controller = new ClientAuthController(
      clientAuth as never,
      turnstile as never,
      abuseQuota as never,
      { NODE_ENV: 'test' } as AppConfig,
    );

    await expect(
      controller.requestLink({ email: 'owner@example.com', challengeToken: 'challenge' }, '203.0.113.8'),
    ).resolves.toEqual({
      message: 'If that email owns any tickets, a sign-in link has been sent.',
    });
    expect(clientAuth.queueRequestLink).toHaveBeenCalledWith('owner@example.com');
  });
});
