import { BadRequestException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration';
import { TurnstileService } from './turnstile.service';

const config = {
  NODE_ENV: 'production',
  TELECOM_HD_PUBLIC_URL: 'https://help.example.net',
  TELECOM_HD_TURNSTILE_HOSTNAME: 'help.example.net',
  TELECOM_HD_TURNSTILE_SECRET: 'strong-turnstile-secret-value-with-entropy',
} as AppConfig;

describe('TurnstileService', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only a fresh response bound to the expected hostname and action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            hostname: 'help.example.net',
            action: 'ticket-create',
            challenge_ts: new Date().toISOString(),
          }),
      }),
    );
    await expect(new TurnstileService(config).verify('token', 'ticket-create')).resolves.toBeUndefined();
  });

  it('rejects cross-action replay even when siteverify says success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            hostname: 'help.example.net',
            action: 'public-upload',
            challenge_ts: new Date().toISOString(),
          }),
      }),
    );
    await expect(new TurnstileService(config).verify('token', 'ticket-create')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('allows missing challenge configuration only outside production', async () => {
    const dev = { ...config, NODE_ENV: 'test', TELECOM_HD_TURNSTILE_SECRET: undefined } as AppConfig;
    await expect(new TurnstileService(dev).verify(undefined, 'ticket-create')).resolves.toBeUndefined();
  });
});
