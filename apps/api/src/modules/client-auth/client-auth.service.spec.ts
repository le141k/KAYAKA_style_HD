import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { ClientAuthService, normalizeEmail } from './client-auth.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AppConfig } from '../../config/configuration';
import { RequestLinkSchema } from './dto';

const CONFIG = {
  NODE_ENV: 'test',
  TELECOM_HD_PUBLIC_URL: 'https://help.example.net',
} as unknown as AppConfig;

function makePrismaMock() {
  const prisma = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(),
    // Default: the resolved owner is enabled and on identity version zero.
    user: { findUnique: vi.fn().mockResolvedValue({ isEnabled: true, clientAuthVersion: 0 }) },
    ticket: { count: vi.fn() },
    clientLoginToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      // Default: under the per-owner magic-link cap.
      count: vi.fn().mockResolvedValue(0),
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
  };
  // Unit transactions are serialized to model the per-owner advisory xact lock. Tests also
  // assert that the lock SQL is issued; PostgreSQL owns the actual concurrency guarantee.
  let transactionTail: Promise<unknown> = Promise.resolve();
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => Promise<unknown>) => {
    const run = transactionTail.then(() => callback(prisma));
    transactionTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  });
  return prisma as unknown as PrismaService;
}

function mockOwnership(prisma: ReturnType<typeof makePrismaMock>, rows: { userId: number }[]): void {
  (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockImplementation(
    (strings: TemplateStringsArray | string) => {
      const sql = typeof strings === 'string' ? strings : Array.from(strings).join('');
      return Promise.resolve(sql.includes('FROM "UserEmail"') ? rows : []);
    },
  );
}

function makeMail() {
  return { sendTemplateStrict: vi.fn().mockResolvedValue(undefined) };
}

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('normalizes before request-link boundary validation', () => {
    expect(
      RequestLinkSchema.parse({ email: '\t Alice@Example.COM \r', challengeToken: 'challenge' }),
    ).toEqual({
      email: 'alice@example.com',
      challengeToken: 'challenge',
    });
  });
});

describe('ClientAuthService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let mail: ReturnType<typeof makeMail>;
  let service: ClientAuthService;

  beforeEach(() => {
    prisma = makePrismaMock();
    mockOwnership(prisma, [{ userId: 5 }]);
    mail = makeMail();
    service = new ClientAuthService(prisma as unknown as PrismaService, CONFIG, mail);
  });

  // ─── requestLink (no enumeration) ──────────────────────────────────────────

  describe('requestLink', () => {
    it('detaches lookup and SMTP from the public response path', () => {
      const dispatch = vi.spyOn(service, 'requestLink').mockReturnValue(new Promise(() => undefined));

      expect(service.queueRequestLink('user@example.com')).toBeUndefined();
      expect(dispatch).toHaveBeenCalledWith('user@example.com');
    });

    it('absorbs background dispatch failures without exposing them to the caller', async () => {
      vi.spyOn(service, 'requestLink').mockRejectedValue(new Error('database unavailable'));

      expect(service.queueRequestLink('user@example.com')).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it('sends a fragment link when the email maps to exactly one user who owns tickets', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      (prisma.clientLoginToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 't1' });

      await service.requestLink('user@example.com');

      expect(prisma.clientLoginToken.create).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringContaining('pg_advisory_xact_lock')]),
        expect.any(Number),
        5,
      );
      const [, key, , vars] = mail.sendTemplateStrict.mock.calls[0] as [
        string,
        string,
        string,
        Record<string, string>,
      ];
      expect(key).toBe('client_login_link');
      // Path is `/verify` (the (client) route group serves at root), token in the fragment.
      expect(vars.verifyUrl).toContain('/verify#token=');
      expect(vars.verifyUrl).not.toContain('/client/verify');
      expect(vars.verifyUrl).not.toContain('?token=');
    });

    it('is a silent no-op for an AMBIGUOUS email (maps to two users)', async () => {
      mockOwnership(prisma, [{ userId: 5 }, { userId: 6 }]);

      await service.requestLink('shared@example.com');

      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
      expect(mail.sendTemplateStrict).not.toHaveBeenCalled();
    });

    it('is a silent no-op for an unknown email', async () => {
      mockOwnership(prisma, []);
      await service.requestLink('nobody@example.com');
      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
    });

    it('is a silent no-op when the user owns no tickets', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      await service.requestLink('user@example.com');
      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
    });

    it('is a silent no-op for a DISABLED user (blocker #5)', async () => {
      (prisma.user.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        isEnabled: false,
        clientAuthVersion: 1,
      });
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
      await service.requestLink('user@example.com');
      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
    });

    it('stops issuing links once the per-owner mail-bomb cap is hit (blocker)', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      (prisma.clientLoginToken.count as ReturnType<typeof vi.fn>).mockResolvedValue(3); // at cap
      await service.requestLink('user@example.com');
      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
    });

    it('invalidates the freshly-issued token when mail dispatch fails', async () => {
      mail.sendTemplateStrict.mockRejectedValue(new Error('smtp down'));
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (prisma.clientLoginToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 't1' });

      await expect(service.requestLink('user@example.com')).resolves.toBeUndefined();
      expect(prisma.clientLoginToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 't1', usedAt: null } }),
      );
    });

    it('fails closed on a whitespace/case collision found by DB lower(btrim)', async () => {
      mockOwnership(prisma, [{ userId: 5 }, { userId: 6 }]);

      await service.requestLink(' shared@example.com ');

      const ownershipCall = (prisma.$queryRaw as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(Array.from(ownershipCall[0] as TemplateStringsArray).join('')).toContain('lower(btrim("email",');
      expect(prisma.clientLoginToken.create).not.toHaveBeenCalled();
    });

    it('serializes parallel requests so the cap and single-active-token transition stay atomic', async () => {
      (prisma.ticket.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      let createdCount = 0;
      let activeCount = 0;
      (prisma.clientLoginToken.count as ReturnType<typeof vi.fn>).mockImplementation(
        async () => createdCount,
      );
      (prisma.clientLoginToken.updateMany as ReturnType<typeof vi.fn>).mockImplementation(
        async (args: { where: { id?: string } }) => {
          if (!args.where.id) activeCount = 0;
          return { count: 1 };
        },
      );
      (prisma.clientLoginToken.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        createdCount += 1;
        activeCount += 1;
        return { id: `t${createdCount}` };
      });

      await Promise.all([service.requestLink('user@example.com'), service.requestLink(' USER@example.com ')]);

      expect(createdCount).toBe(2);
      expect(activeCount).toBe(1);
      expect(mail.sendTemplateStrict).toHaveBeenCalledTimes(2);
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
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientAuthVersion: 3,
        user: { isEnabled: true, clientAuthVersion: 3 },
      });

      const { sessionToken } = await service.verify('raw-token');

      expect(typeof sessionToken).toBe('string');
      expect(sessionToken.length).toBeGreaterThan(20);
      expect(prisma.clientSession.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientAuthVersion: 3 }) }),
      );
    });

    it('rejects a used/expired/replayed token (zero rows consumed)', async () => {
      (prisma.clientLoginToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 't1',
        userId: 5,
        email: 'user@example.com',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientAuthVersion: 3,
        user: { isEnabled: true, clientAuthVersion: 3 },
      });
      (prisma.clientLoginToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      await expect(service.verify('raw-token')).rejects.toThrow(UnauthorizedException);
      expect(prisma.clientSession.create).not.toHaveBeenCalled();
    });

    it('rejects a token issued before disable even after the user is re-enabled', async () => {
      (prisma.clientLoginToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'old',
        userId: 5,
        email: 'user@example.com',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientAuthVersion: 3,
        user: { isEnabled: true, clientAuthVersion: 5 },
      });

      await expect(service.verify('pre-disable-token')).rejects.toThrow(UnauthorizedException);
      expect(prisma.clientLoginToken.updateMany).not.toHaveBeenCalled();
      expect(prisma.clientSession.create).not.toHaveBeenCalled();
    });

    it('rejects a still-version-matching token while the user is disabled', async () => {
      (prisma.clientLoginToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 'disabled',
        userId: 5,
        email: 'user@example.com',
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientAuthVersion: 4,
        user: { isEnabled: false, clientAuthVersion: 4 },
      });

      await expect(service.verify('disabled-token')).rejects.toThrow(UnauthorizedException);
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
        clientAuthVersion: 3,
        user: { isEnabled: true, clientAuthVersion: 3 },
      });
      const principal = await service.resolveSession('raw');
      expect(principal).toEqual({ userId: 5 });
    });

    it('returns null when the session user has since been DISABLED (blocker #5)', async () => {
      (prisma.clientSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 's1',
        userId: 5,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientAuthVersion: 3,
        user: { isEnabled: false, clientAuthVersion: 3 },
      });
      expect(await service.resolveSession('raw')).toBeNull();
    });

    it('returns null after an email/enable identity-version change', async () => {
      (prisma.clientSession.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 's1',
        userId: 5,
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        clientAuthVersion: 3,
        user: { isEnabled: true, clientAuthVersion: 4 },
      });
      expect(await service.resolveSession('raw')).toBeNull();
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
