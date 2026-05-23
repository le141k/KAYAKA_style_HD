import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import type { ArgumentsHost } from '@nestjs/common';
import { PrismaExceptionFilter } from './prisma-exception.filter';

function makeHost(): {
  host: ArgumentsHost;
  res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
} {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const res = { status, json };
  const host = {
    switchToHttp: () => ({ getResponse: () => res }),
  } as unknown as ArgumentsHost;
  return { host, res };
}

function knownError(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
    meta,
  });
}

describe('PrismaExceptionFilter', () => {
  let filter: PrismaExceptionFilter;
  beforeEach(() => {
    filter = new PrismaExceptionFilter();
  });

  it('maps P2025 (not found) to 404', () => {
    const { host, res } = makeHost();
    filter.catch(knownError('P2025'), host);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
  });

  it('maps P2003 (FK constraint) to 400', () => {
    const { host, res } = makeHost();
    filter.catch(knownError('P2003', { field_name: 'departmentId' }), host);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: expect.stringContaining('departmentId') }),
    );
  });

  it('maps P2002 (unique constraint) to 409', () => {
    const { host, res } = makeHost();
    filter.catch(knownError('P2002', { target: ['email'] }), host);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: expect.stringContaining('email') }),
    );
  });

  it('falls back to 500 for unknown codes', () => {
    const { host, res } = makeHost();
    filter.catch(knownError('P2099'), host);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
