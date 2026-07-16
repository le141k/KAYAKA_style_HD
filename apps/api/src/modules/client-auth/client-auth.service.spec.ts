import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService, normalizeEmail } from './client-auth.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AppConfig } from '../../config/configuration';

const CONFIG = {
  NODE_ENV: 'test',
  TELECOM_HD_PUBLIC_URL: 'https://help.example.net',
} as unknown as AppConfig;

function makePrismaMock() {
  return {
    userEmail: { findMany: vi.fn() },
    ticket: { count: vi.fn() },
    clientLoginToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    clientSession: {
      create: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
}

function makeMail() {
  return { sendTemplateStrict: vi.fn().mockResolvedValue(undefined) };
}

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });
});

describe('ClientAuthService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let mail: ReturnType<typeof makeMail>;
  let service: ClientAuthService;

  beforeEach(() => {
    prisma = makePrismaMock();
    mail = makeMail();
    service = new ClientAuthService(prisma as unknown as PrismaService, CONFIG, mail);
  });

  // ─── requestLink (no enumeration) ──────────────────────────────────────────

  describe('requestLink', () => {
    it('sends a fragment link when the email maps to exactly one user who owns tickets', async () => {
      (prisma.userEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ userId: 5 }]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      (prisma.clientLoginToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 't1' });

      await service.requestLink('user@example.com');

      expect(prisma.clientLoginToken.create).toHaveBeenCalledTimes(1);
      const [, key, , vars] = mail.sendTemplateStrict.mock.calls[0] as [
        string,
        string,
        string,
        Record<string, string>,
      ];
      expect(key).toBe('client_login_link');
      expect(vars.verifyUrl).toContain('/client/verify#token=');
      expect(vars.verifyUrl).not.toContain('?token=');
    });

    it('is a silent no-op for an AMBIGUOUS email (maps to two users)', async () => {
      (prisma.userEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        { userId: 5 },
        { userId: 6 },
      ]);

      await service.requestLink('shared@example.com');

      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
      expect(mail.sendTemplateStrict).not.toHaveBeenCalled();
    });

    it('is a silent no-op for an unknown email', async () => {
      (prisma.userEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await service.requestLink('nobody@example.com');
      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
    });

    it('is a silent no-op when the user owns no tickets', async () => {
      (prisma.userEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ userId: 5 }]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      await service.requestLink('user@example.com');
      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
    });

    it('invalidates the freshly-issued token when mail dispatch fails', async () => {
      mail.sendTemplateStrict.mockRejectedValue(new Error('smtp down'));
      (prisma.userEmail.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ userId: 5 }]);
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (prisma.clientLoginToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 't1' });

      await expect(service.requestLink('user@example.com')).resolves.toBeUndefined();
      expect(prisma.clientLoginToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 't1', usedAt: null } }),
      );
    });
  });

  // ─── verify (atomic single-use consume) ────────────────────────────────────

  describe('verify', () => {
    it('consumes an unused token exactly once and opens a session', async () => {
      (prisma.clientLoginToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.clientLoginToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 't1',
        userId: 5,
        email: 'user@example.com',
      });

      const { sessionToken } = await service.verify('raw-token');

      expect(typeof sessionToken).toBe('string');
      expect(sessionToken.length).toBeGreaterThan(20);
      expect(prisma.clientSession.create).toHaveBeenCalledTimes(1);
    });

    it('rejects a used/expired/replayed token (zero rows consumed)', async () => {
      (prisma.clientLoginToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      await expect(service.verify('raw-token')).rejects.toThrow(UnauthorizedException);
      expect(prisma.clientSession.create).not.toHaveBeenCalled();
    });
  });

  // ─── resolveSession ────────────────────────────────────────────────────────

  describe('resolveSession', () => {
    it('returns the principal for a live session', async () => {
      (prisma.clientSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 's1',
        userId: 5,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      const principal = await service.resolveSession('raw');
      expect(principal).toEqual({ userId: 5 });
    });

    it('returns null for a revoked session', async () => {
      (prisma.clientSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 's1',
        userId: 5,
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      expect(await service.resolveSession('raw')).toBeNull();
    });

    it('returns null for an expired session', async () => {
      (prisma.clientSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 's1',
        userId: 5,
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(await service.resolveSession('raw')).toBeNull();
    });

    it('returns null when the session is unknown', async () => {
      (prisma.clientSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      expect(await service.resolveSession('raw')).toBeNull();
    });
  });
});
