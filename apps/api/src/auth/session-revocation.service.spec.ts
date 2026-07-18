import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRevocationService } from './session-revocation.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { TokenBlocklistService } from './token-blocklist.service';
import type { AppConfig } from '../config/configuration';

function makePrismaMock() {
  return {
    refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    // revokeAllForStaff also burns pending password-reset tokens (blocker #7).
    passwordReset: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    staff: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
}

const CONFIG = { TELECOM_HD_JWT_ACCESS_TTL: 900 } as AppConfig;

describe('SessionRevocationService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let blocklist: { revokeStaffAccessBefore: ReturnType<typeof vi.fn> };
  let svc: SessionRevocationService;

  beforeEach(() => {
    prisma = makePrismaMock();
    blocklist = { revokeStaffAccessBefore: vi.fn().mockResolvedValue(undefined) };
    svc = new SessionRevocationService(
      prisma as unknown as PrismaService,
      CONFIG,
      blocklist as unknown as TokenBlocklistService,
    );
  });

  it('revokeAllForStaff revokes refresh tokens AND sets the access cutoff', async () => {
    await svc.revokeAllForStaff(7);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { staffId: 7, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(blocklist.revokeStaffAccessBefore).toHaveBeenCalledWith(7, 900);
  });

  it('revokeAllForStaff also burns pending password-reset tokens (blocker #7)', async () => {
    await svc.revokeAllForStaff(7);
    expect(
      (prisma as unknown as { passwordReset: { updateMany: ReturnType<typeof vi.fn> } }).passwordReset
        .updateMany,
    ).toHaveBeenCalledWith({ where: { staffId: 7, usedAt: null }, data: { usedAt: expect.any(Date) } });
  });

  it('revokeAllForGroup revokes for every member and sets a cutoff each', async () => {
    (prisma.staff.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 3 }, { id: 5 }]);
    await svc.revokeAllForGroup(2);

    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { staffId: { in: [3, 5] }, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(blocklist.revokeStaffAccessBefore).toHaveBeenCalledTimes(2);
    expect(blocklist.revokeStaffAccessBefore).toHaveBeenCalledWith(3, 900);
    expect(blocklist.revokeStaffAccessBefore).toHaveBeenCalledWith(5, 900);
  });

  it('revokeAllForGroup is a no-op when the group has no members', async () => {
    (prisma.staff.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await svc.revokeAllForGroup(2);
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(blocklist.revokeStaffAccessBefore).not.toHaveBeenCalled();
  });

  it('works without a blocklist (Redis absent) — refresh revocation still runs', async () => {
    const noRedis = new SessionRevocationService(prisma as unknown as PrismaService, CONFIG, undefined);
    await noRedis.revokeAllForStaff(9);
    expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
  });
});
