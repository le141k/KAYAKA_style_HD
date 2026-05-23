import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import * as passwordUtil from './password.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { AppConfig } from '../config/configuration';

// ─── Mocks ────────────────────────────────────────────────────────────────────

function makePrismaMock() {
  return {
    staff: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  } as unknown as PrismaService;
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
  staffGroupId: 1,
  staffGroup: MOCK_STAFF_GROUP,
  lastLoginAt: null,
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
});
