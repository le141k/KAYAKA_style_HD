import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/configuration';
import { PublicWriteGuard } from './public-write.guard';

describe('PublicWriteGuard', () => {
  it('keeps public uploads independently closed in production', () => {
    const reflector = { get: vi.fn().mockReturnValue('upload') };
    const config = {
      NODE_ENV: 'production',
      TELECOM_HD_PUBLIC_UPLOAD_ENABLED: false,
      TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED: true,
    } as AppConfig;
    const guard = new PublicWriteGuard(reflector as never, config);
    expect(() => guard.canActivate({ getHandler: () => undefined } as never)).toThrow(NotFoundException);
  });
});
