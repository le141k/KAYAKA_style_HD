import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CustomFieldsService } from './custom-fields.service';
import type { PrismaService } from '../../prisma/prisma.service';

function makePrismaMock() {
  return {
    customFieldGroup: { findMany: vi.fn() },
  } as unknown as PrismaService;
}

describe('CustomFieldsService', () => {
  let service: CustomFieldsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new CustomFieldsService(prisma as unknown as PrismaService);
  });

  it('filters by scope and maps fields without isEncrypted', async () => {
    (prisma.customFieldGroup.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 1,
        title: 'Network details',
        scope: 'TICKET',
        displayOrder: 0,
        fields: [
          {
            id: 10,
            fieldKey: 'circuit_id',
            title: 'Circuit ID',
            type: 'TEXT',
            isRequired: true,
            isEncrypted: true,
            displayOrder: 0,
            options: [],
          },
        ],
      },
    ]);

    const result = await service.listByScope('TICKET');

    expect(prisma.customFieldGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: 'TICKET' } }),
    );
    expect(result).toHaveLength(1);
    const field = result[0]!.fields[0]!;
    expect(field).toEqual({
      id: 10,
      fieldKey: 'circuit_id',
      title: 'Circuit ID',
      type: 'TEXT',
      isRequired: true,
      displayOrder: 0,
      options: [],
    });
    expect(field).not.toHaveProperty('isEncrypted');
  });

  it('defaults to TICKET scope', async () => {
    (prisma.customFieldGroup.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    await service.listByScope();
    expect(prisma.customFieldGroup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { scope: 'TICKET' } }),
    );
  });
});
