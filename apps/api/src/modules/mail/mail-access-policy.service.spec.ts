import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { MailAccessPolicy } from './mail-access-policy.service';

function makePolicy(assignments: number[]) {
  const prisma = {
    departmentStaff: {
      findMany: vi.fn().mockResolvedValue(assignments.map((departmentId) => ({ departmentId }))),
    },
  };
  return { policy: new MailAccessPolicy(prisma as never), prisma };
}

describe('MailAccessPolicy', () => {
  it('gives only actual administrators an unrestricted mail scope', async () => {
    const { policy, prisma } = makePolicy([4]);

    await expect(policy.resolveScope({ staffId: 11, isAdmin: true })).resolves.toEqual({
      unrestricted: true,
      departmentIds: [],
    });
    expect(prisma.departmentStaff.findMany).not.toHaveBeenCalled();
  });

  it('fails closed for a non-admin with no department assignment', async () => {
    const { policy } = makePolicy([]);
    const scope = await policy.resolveScope({ staffId: 12, isAdmin: false });

    expect(scope).toEqual({ unrestricted: false, departmentIds: [] });
    expect(policy.queueWhereForScope(scope)).toEqual({ departmentId: { in: [] } });
    expect(policy.ticketWhereForScope(scope)).toEqual({ departmentId: { in: [] } });
    expect(policy.deliveryWhereForScope(scope)).toEqual({
      AND: [
        { departmentId: { in: [] } },
        { OR: [{ queueId: null }, { queue: { is: { departmentId: { in: [] } } } }] },
      ],
    });
  });

  it('uses both the immutable delivery snapshot and source queue for department access', async () => {
    const { policy } = makePolicy([3, 3, 8]);
    const scope = await policy.resolveScope({ staffId: 13, isAdmin: false });

    expect(scope).toEqual({ unrestricted: false, departmentIds: [3, 8] });
    expect(policy.deliveryByIdWhereForScope(91, scope)).toEqual({
      AND: [
        { id: 91 },
        {
          AND: [
            { departmentId: { in: [3, 8] } },
            { OR: [{ queueId: null }, { queue: { is: { departmentId: { in: [3, 8] } } } }] },
          ],
        },
      ],
    });
  });

  it('does not let a scoped operator create or move queues into another department', async () => {
    const { policy } = makePolicy([3]);
    const scope = await policy.resolveScope({ staffId: 14, isAdmin: false });

    expect(() => policy.assertCanTargetQueueDepartment(scope, 3)).not.toThrow();
    expect(() => policy.assertCanTargetQueueDepartment(scope, 8)).toThrow(NotFoundException);
    expect(() => policy.assertCanTargetQueueDepartment(scope, null)).toThrow(NotFoundException);
  });
});
