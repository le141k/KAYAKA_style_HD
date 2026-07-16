import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RbacAuditService } from './rbac-audit.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    rbacAuditLog: {
      create: vi.fn().mockResolvedValue({ id: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  } as unknown as PrismaService;
}

describe('RbacAuditService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let svc: RbacAuditService;

  beforeEach(() => {
    prisma = makePrismaMock();
    svc = new RbacAuditService(prisma as unknown as PrismaService);
  });

  it('log() persists the actor, action, target and metadata', async () => {
    await svc.log({
      actor: { staffId: 1, email: 'admin@example.com' },
      action: 'staff.role_change',
      targetType: 'staff',
      targetId: 42,
      targetLabel: 'bob@example.com',
      metadata: { fromGroupId: 2, toGroupId: 3 },
    });
    expect(prisma.rbacAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorStaffId: 1,
        actorEmail: 'admin@example.com',
        action: 'staff.role_change',
        targetType: 'staff',
        targetId: 42,
        targetLabel: 'bob@example.com',
        metadata: { fromGroupId: 2, toGroupId: 3 },
      },
    });
  });

  it('log() tolerates a missing actor (system action)', async () => {
    await svc.log({ action: 'group.create', targetType: 'group', targetId: 5 });
    expect(prisma.rbacAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorStaffId: null, actorEmail: '', metadata: {} }),
      }),
    );
  });

  it('log() never throws even if the DB insert fails (best-effort)', async () => {
    (prisma.rbacAuditLog.create as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    await expect(
      svc.log({ action: 'staff.disable', targetType: 'staff', targetId: 1 }),
    ).resolves.toBeUndefined();
  });

  it('list() returns paginated rows newest-first', async () => {
    (prisma.rbacAuditLog.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 2 }, { id: 1 }]);
    (prisma.rbacAuditLog.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);

    const res = await svc.list({ page: 1, limit: 50 });
    expect(res.total).toBe(2);
    expect(res.data).toHaveLength(2);
    expect(prisma.rbacAuditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'desc' }, skip: 0, take: 50 }),
    );
  });
});
