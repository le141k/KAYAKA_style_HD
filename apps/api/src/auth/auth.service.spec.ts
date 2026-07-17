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
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // Support BOTH styles: array form ($transaction([...]) → resolves []) used by the
    // merged reset/revoke paths, and the legacy callback form ($transaction(fn) → fn(prisma)).
    $transaction: vi.fn(),
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

const TEST_CONFIG: AppConfig = {
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
};

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

    // ─── D2: per-account lockout ───────────────────────────────────────────────

    it('increments failedLoginAttempts on a wrong password (below threshold)', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        failedLoginAttempts: 2,
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(false);

      await expect(service.validateStaff('test@23telecom.example', 'nope')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { failedLoginAttempts: 3 } }),
      );
    });

    it('locks the account once attempts reach the threshold', async () => {
      // 4 prior failures + this one = 5 (default LOGIN_MAX_ATTEMPTS) → lock.
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        failedLoginAttempts: 4,
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(false);

      await expect(service.validateStaff('test@23telecom.example', 'nope')).rejects.toThrow(
        UnauthorizedException,
      );
      const call = (prisma.staff.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(call.data.failedLoginAttempts).toBe(0);
      expect(call.data.lockedUntil).toBeInstanceOf(Date);
      expect((call.data.lockedUntil as Date).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects while locked even with the correct password (no verify)', async () => {
      const verifySpy = vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        lockedUntil: new Date(Date.now() + 10 * 60_000),
      });

      await expect(service.validateStaff('test@23telecom.example', 'demo1234')).rejects.toThrow(
        /temporarily locked/,
      );
      expect(verifySpy).not.toHaveBeenCalled();
    });

    it('allows login once the lock has expired and clears failure state', async () => {
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...MOCK_STAFF,
        failedLoginAttempts: 3,
        lockedUntil: new Date(Date.now() - 60_000), // expired
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);

      const result = await service.validateStaff('test@23telecom.example', 'demo1234');
      expect(result.email).toBe('test@23telecom.example');
      expect(prisma.staff.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { failedLoginAttempts: 0, lockedUntil: null } }),
      );
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

    it('a concurrent loser (CAS count 0, revoked just now) fails WITHOUT revoking the family', async () => {
      jwt.verify.mockReturnValue({ sub: 1, jti: 'jti-1', fid: 'fam-1' });
      // Row read as still-active; the winner revokes it between our read and CAS.
      (prisma.refreshToken.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...RT_ROW,
        revokedAt: null,
      });
      vi.spyOn(passwordUtil, 'verifyPassword').mockResolvedValue(true);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.refreshToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await expect(service.refresh('raw-token')).rejects.toThrow('already rotated');
      // Only the CAS updateMany ran — no family-wide revocation.
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledTimes(1);
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

  // ─── password reset ───────────────────────────────────────────────────────

  describe('resetPassword', () => {
    it('claims the reset token once and revokes access sessions after the password changes', async () => {
      const sessions = { revokeAllForStaff: vi.fn().mockResolvedValue(undefined) };
      service = new AuthService(
        prisma as unknown as PrismaService,
        jwt as unknown as import('@nestjs/jwt').JwtService,
        TEST_CONFIG,
        undefined,
        sessions as never,
      );
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 9,
        staffId: 1,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.staff.update as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ isEnabled: true });
      (prisma.refreshToken.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-password-hash');

      await service.resetPassword('single-use-token', 'newpassword');

      // S1-5 atomic consume is keyed by the token HASH (not id) and claimed outside a tx.
      expect(prisma.passwordReset.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            tokenHash: expect.any(String),
            usedAt: null,
            expiresAt: expect.anything(),
          }),
        }),
      );
      expect(sessions.revokeAllForStaff).toHaveBeenCalledWith(1);
    });

    it('rejects a reset token that another request has already claimed', async () => {
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 9,
        staffId: 1,
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-password-hash');

      await expect(service.resetPassword('already-claimed', 'newpassword')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.staff.update).not.toHaveBeenCalled();
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
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      (prisma.passwordReset.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 42 });

      await makeServiceWithMail(mail).forgotPassword('test@23telecom.example');

      expect(prisma.passwordReset.create).toHaveBeenCalledTimes(1);
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
    });

    it('invalidates the freshly-issued token and stays silent when dispatch fails', async () => {
      const mail = makeMailMock();
      mail.sendTemplateStrict.mockRejectedValue(new Error('redis down'));
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });
      (prisma.passwordReset.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 42 });

      // Must NOT throw (generic response / no enumeration).
      await expect(
        makeServiceWithMail(mail).forgotPassword('test@23telecom.example'),
      ).resolves.toBeUndefined();

      // The created token (id 42) is invalidated so no live token dangles.
      expect(prisma.passwordReset.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 42, usedAt: null } }),
      );
    });
  });

  // ─── resetPassword (atomic consume) ──────────────────────────────────────────

  describe('resetPassword', () => {
    it('consumes an unused token exactly once and updates the password', async () => {
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-hash');
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        staffId: 1,
        tokenHash: 'hash',
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      });
      // Blocker #7: resetPassword now checks the target staff is enabled.
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ isEnabled: true });

      await service.resetPassword('raw-token', 'new-password-123');

      // Conditional consume keyed on usedAt:null AND not expired.
      expect(prisma.passwordReset.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            usedAt: null,
            expiresAt: expect.objectContaining({ gt: expect.any(Date) }),
          }),
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('rejects a reset for a DISABLED staff account (blocker #7)', async () => {
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-hash');
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
      (prisma.passwordReset.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        staffId: 1,
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
      });
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ isEnabled: false });

      await expect(service.resetPassword('raw', 'new-password-123')).rejects.toThrow(BadRequestException);
      expect(prisma.staff.update).not.toHaveBeenCalled();
    });

    it('rejects a replayed/used/expired token (zero rows consumed) without changing the password', async () => {
      vi.spyOn(passwordUtil, 'hashPassword').mockResolvedValue('new-hash');
      (prisma.passwordReset.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 0 });

      await expect(service.resetPassword('raw-token', 'new-password-123')).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.passwordReset.findUnique).not.toHaveBeenCalled();
    });
  });
});
