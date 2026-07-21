import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService, type ResetMailer } from './auth.service';
import * as passwordUtil from './password.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { AppConfig } from '../config/configuration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makePrismaMock() {
  const prisma = {
    staff: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    passwordReset: {
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // Support BOTH styles: array form ($transaction([...]) → resolves []) used by the
    // merged reset/revoke paths, and the legacy callback form ($transaction(fn) → fn(prisma)).
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
      : Promise.resolve([]),
  );
  return prisma as unknown as PrismaService;
}

function makeMailMock() {
  return { sendTemplateStrict: vi.fn().mockResolvedValue(undefined) };
}

function makeJwtMock() {
  return {
    signAsync: vi.fn().mockResolvedValue('signed-token'),
    verify: vi.fn(),
    verifyAsync: vi.fn(),
  };
}

const TEST_CONFIG = {
  NODE_ENV: 'test',
  TELECOM_HD_API_PORT: 4000,
  TELECOM_HD_PUBLIC_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://localhost/test',
  REDIS_URL: 'redis://localhost:6379',
  TELECOM_HD_JWT_ACCESS_SECRET: 'test-access-secret',
  TELECOM_HD_JWT_REFRESH_SECRET: 'test-refresh-secret',
  TELECOM_HD_JWT_ACCESS_TTL: 900,
  TELECOM_HD_JWT_REFRESH_TTL: 2592000,
  TELECOM_HD_SMTP_HOST: 'localhost',
  TELECOM_HD_SMTP_PORT: 1025,
  TELECOM_HD_SMTP_SECURE: false,
  TELECOM_HD_MAIL_FROM: 'test@test.example',
  TELECOM_HD_LOG_LEVEL: 'silent',
  TELECOM_HD_ALARIS_WEBHOOK_SECRET: 'test-secret',
  TELECOM_HD_INBOUND_WEBHOOK_SECRET: 'test-inbound-secret',
  TELECOM_HD_UPLOAD_DIR: '/tmp/uploads',
  TELECOM_HD_UPLOAD_MAX_SIZE_MB: 25,
  TELECOM_HD_CLIENT_PORTAL_ENABLED: false,
  TELECOM_HD_IMAP_ENABLED: false,
  TELECOM_HD_IMAP_BOOTSTRAP_POLICY: 'FROM_NOW',
  TELECOM_HD_IMAP_BACKFILL_LIMIT: 0,
  TELECOM_HD_INBOUND_MAX_ATTEMPTS: 5,
  TELECOM_HD_INBOUND_RAW_RETENTION_DAYS: 30,
} as AppConfig;

const MOCK_STAFF_GROUP = {
  id: 1,
  title: 'Admin',
  isAdmin: true,
  permissions: ['ticket.view'],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const MOCK_STAFF = {
  id: 1,
  email: 'test@23telecom.example',
  username: 'teststaff',
  firstName: 'Test',
  lastName: 'Staff',
  passwordHash: '$argon2id$test-hash',
  designation: '',
  signature: '',
  mobileNumber: '',
  timezone: 'UTC',
  isEnabled: true,
  authVersion: 0,
  staffGroupId: 1,
  staffGroup: MOCK_STAFF_GROUP,
  lastLoginAt: null,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AuthService', () => {
  let service: AuthService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let jwt: ReturnType<typeof makeJwtMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    (prisma.$queryRaw as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, authVersion: MOCK_STAFF.authVersion, isEnabled: true },
    ]);
    jwt = makeJwtMock();
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as import('@nestjs/jwt').JwtService,
      TEST_CONFIG,
    );
  });

  // ─── validateStaff ─────────────────────────────────────────────────────────

  describe('validateStaff', () => {
    it('returns staff record on correct credentials', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);

      const result = await service.validateStaff('test@23telecom.example', 'demo1234');
      expect(result.email).toBe('test@23telecom.example');
    });

    it('throws UnauthorizedException when staff not found', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.validateStaff('bad@example.com', 'pass')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when staff is disabled', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        isEnabled: false,
      });

      await expect(service.validateStaff('test@23telecom.example', 'demo1234')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('throws UnauthorizedException on wrong password', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(false);

      await expect(service.validateStaff('test@23telecom.example', 'wrong-password')).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('ignores legacy DB lock columns and accepts valid credentials', async () => {
      const verifySpy = vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        failedLoginAttempts: 99,
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      });

      await expect(service.validateStaff('test@23telecom.example', 'demo1234')).resolves.toMatchObject({
        id: 1,
      });
      expect(verifySpy).toHaveBeenCalled();
      expect(prisma.staff.update).not.toHaveBeenCalled();
    });

    it('does not write legacy DB lock counters after a failed password', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        failedLoginAttempts: 3,
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(false);

      await expect(service.validateStaff('test@23telecom.example', 'wrong')).rejects.toThrow(
        'Invalid credentials',
      );
      expect(prisma.staff.update).not.toHaveBeenCalled();
    });
  });

  // ─── login ─────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('issues access and refresh tokens on success', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('hashed-rt');
      (prisma.refreshToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({});
      (prisma.staff.update as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);

      const result = await service.login('test@23telecom.example', 'demo1234');

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.staff.email).toBe('test@23telecom.example');
      expect(result.staff.isAdmin).toBe(true);
      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ issuedAtMs: expect.any(Number) }),
        expect.anything(),
      );
    });
  });

  // ─── refresh (S3-3 rotation) ─────────────────────────────────────────────────

  describe('refresh', () => {
    const RT_ROW = {
      id: 'row-1',
      staffId: 1,
      jti: 'jti-1',
      familyId: 'fam-1',
      authVersion: 0, // matches MOCK_STAFF.authVersion
      tokenHash: 'argon-hash',
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null as Date | null,
      createdAt: new Date(),
    };

    it('rotates a valid token: direct jti lookup, CAS consume, issues a new pair', async () => {
      jwt.verify.mockReturnValue({ sub: 1, jti: 'jti-1', fid: 'fam-1' });
      (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...RT_ROW });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-hash');
      (prisma.refreshToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.refreshToken.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

      const result = await service.refresh('raw-token');

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({ where: { jti: 'jti-1' } });
      // CAS consume keyed on jti + revokedAt null.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { jti: 'jti-1', revokedAt: null } }),
      );
      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      // The rotated pair must NOT leak the internal refreshJti.
      expect(result).not.toHaveProperty('refreshJti');
    });

    it('rejects an unknown jti (no scan)', async () => {
      jwt.verify.mockReturnValue({ sub: 1, jti: 'ghost', fid: 'fam-1' });
      (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.refresh('raw-token')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when the raw token does not match the stored hash', async () => {
      jwt.verify.mockReturnValue({ sub: 1, jti: 'jti-1', fid: 'fam-1' });
      (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...RT_ROW });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(false);

      await expect(service.refresh('raw-token')).rejects.toThrow(UnauthorizedException);
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('a concurrent loser gets access-only recovery WITHOUT revoking the family', async () => {
      jwt.verify.mockReturnValue({ sub: 1, jti: 'jti-1', fid: 'fam-1' });
      // Row read as still-active; the winner revokes it between our read and CAS.
      (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...RT_ROW,
        revokedAt: null,
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.refreshToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await expect(service.refresh('raw-token')).resolves.toEqual({
        accessToken: 'signed-token',
        refreshRotated: false,
      });
      // Only the CAS updateMany ran — no family-wide revocation.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('a genuine later replay (revoked long ago, CAS count 0) revokes the whole family', async () => {
      jwt.verify.mockReturnValue({ sub: 1, jti: 'jti-1', fid: 'fam-1' });
      (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...RT_ROW,
        revokedAt: new Date(Date.now() - 60_000), // rotated a minute ago
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.refreshToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await expect(service.refresh('raw-token')).rejects.toThrow('reuse detected');
      // CAS (count 0) + a second updateMany that revokes the family.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.refreshToken.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { familyId: 'fam-1', revokedAt: null } }),
      );
    });

    it('rejects a refresh whose stamped authVersion is stale — WITHOUT a replay alarm (race fix)', async () => {
      // The token's row.authVersion (0) no longer matches the staff (bumped to 1 by a
      // logout-all / password change). Must reject BEFORE the CAS, with no family-revoke.
      jwt.verify.mockReturnValue({ sub: 1, jti: 'jti-1', fid: 'fam-1' });
      (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ ...RT_ROW });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        authVersion: 1,
      });

      await expect(service.refresh('raw-token')).rejects.toThrow('invalidated');
      // No CAS, no family revocation — the security change already revoked the family.
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  // ─── logout ────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('revokes all active refresh tokens for the staff member', async () => {
      (prisma.refreshToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      await service.logout(1);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { staffId: 1, revokedAt: null },
          data: { revokedAt: expect.any(Date) },
        }),
      );
    });
  });

  // ─── buildPrincipal ────────────────────────────────────────────────────────

  describe('buildPrincipal', () => {
    it('maps staff+group to AuthStaff shape', () => {
      const principal = service.buildPrincipal(MOCK_STAFF);
      expect(principal).toEqual({
        staffId: 1,
        email: 'test@23telecom.example',
        isAdmin: true,
        permissions: ['ticket.view'],
        firstName: 'Test',
        lastName: 'Staff',
        fullName: 'Test Staff',
      });
    });
  });

  // ─── forgotPassword ──────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    function makeServiceWithMail(mail: ReturnType<typeof makeMailMock>) {
      return new AuthService(
        prisma as unknown as PrismaService,
        jwt as unknown as import('@nestjs/jwt').JwtService,
        TEST_CONFIG,
        undefined, // blocklist
        undefined, // sessions (SessionRevocationService)
        mail as unknown as ResetMailer,
      );
    }

    it('is a silent no-op for an unknown/disabled email (no token, no mail)', async () => {
      const mail = makeMailMock();
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await makeServiceWithMail(mail).forgotPassword('nobody@example.com');

      expect(prisma.passwordReset.create).not.toHaveBeenCalled();
      expect(mail.sendTemplateStrict).not.toHaveBeenCalled();
    });

    it('creates a token and dispatches the reset mail with a fragment URL', async () => {
      const mail = makeMailMock();
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.passwordReset.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 42 });

      await makeServiceWithMail(mail).forgotPassword('test@23telecom.example');

      expect(prisma.passwordReset.create).toHaveBeenCalledTimes(1);
      expect(prisma.passwordReset.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            authVersion: MOCK_STAFF.authVersion,
            usedAt: expect.any(Date),
          }),
        }),
      );
      expect(mail.sendTemplateStrict).toHaveBeenCalledTimes(1);
      const [, key, , vars] = mail.sendTemplateStrict.mock.calls[0] as [
        string,
        string,
        string,
        Record<string, string>,
      ];
      expect(key).toBe('password_reset');
      // Token must be delivered in the URL fragment, never the query string.
      expect(vars.resetUrl).toContain('/reset-password#token=');
      expect(vars.resetUrl).not.toContain('?token=');
      expect(prisma.passwordReset.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 42, usedAt: { not: null } }),
          data: { usedAt: null },
        }),
      );
    });

    it('keeps the freshly-issued token inactive and stays silent when dispatch fails', async () => {
      const mail = makeMailMock();
      mail.sendTemplateStrict.mockRejectedValue(new Error('redis down'));
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      (prisma.passwordReset.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 42 });

      // Must NOT throw (generic response / no enumeration).
      await expect(
        makeServiceWithMail(mail).forgotPassword('test@23telecom.example'),
      ).resolves.toBeUndefined();

      // The row starts inactive; failed delivery never flips usedAt back to null.
      expect(prisma.passwordReset.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ usedAt: expect.any(Date) }) }),
      );
      expect(prisma.passwordReset.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { usedAt: null } }),
      );
    });
  });

  // ─── resetPassword (atomic consume) ──────────────────────────────────────────

  describe('resetPassword', () => {
    it('rejects an unknown token before running expensive Argon2', async () => {
      const hashSpy = vi.spyOn(passwordUtil, 'hashPassword');
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await expect(service.resetPassword('unknown-token', 'new-password-123')).rejects.toThrow(
        BadRequestException,
      );

      expect(hashSpy).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('atomically consumes a version-matched token, updates password, and revokes sessions', async () => {
      const sessions = { revokeAllForStaff: vi.fn().mockResolvedValue(undefined) };
      service = new AuthService(
        prisma as unknown as PrismaService,
        jwt as unknown as import('@nestjs/jwt').JwtService,
        TEST_CONFIG,
        undefined,
        sessions as never,
      );
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-hash');
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        staffId: 1,
        authVersion: 3,
        tokenHash: 'hash',
        usedAt: null,
        expiresAt: new Date(Date.now() + 1000),
      });
      (prisma.staff.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.refreshToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

      await service.resetPassword('raw-token', 'new-password-123');

      expect(prisma.staff.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1, isEnabled: true, authVersion: 3 },
          data: { passwordHash: 'new-hash', authVersion: { increment: 1 } },
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(sessions.revokeAllForStaff).toHaveBeenCalledWith(1);
    });

    it('rolls back when disable/password change made the token authVersion stale', async () => {
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-hash');
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        staffId: 1,
        authVersion: 3,
        usedAt: null,
        expiresAt: new Date(Date.now() + 1000),
      });
      (prisma.staff.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await expect(service.resetPassword('raw', 'new-password-123')).rejects.toThrow(BadRequestException);
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it('rejects a replayed token inside the transaction without changing the password', async () => {
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-hash');
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        staffId: 1,
        authVersion: 0,
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      });

      await expect(service.resetPassword('raw-token', 'new-password-123')).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.staff.updateMany).not.toHaveBeenCalled();
    });
  });
});
