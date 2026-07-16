import { describe, it, expect, vi } from 'vitest';
import { auditUserEmailOwnership } from './audit-user-email-ownership';
import type { PrismaClient } from '@prisma/client';

/**
 * The audit issues five $queryRaw calls in this order:
 *   1. duplicate email groups
 *   2. un-normalized row count
 *   3. unlinked-ticket sample rows (split into ambiguous vs orphan)
 *   4. ambiguous-ticket total
 *   5. orphan-ticket total
 */
function mockClient(seq: unknown[]): PrismaClient {
  const q = vi.fn();
  for (const v of seq) q.mockResolvedValueOnce(v);
  return { $queryRaw: q } as unknown as PrismaClient;
}

describe('auditUserEmailOwnership (S2-2)', () => {
  it('reports CLEAN when there are no duplicates, un-normalized rows or orphan tickets', async () => {
    const client = mockClient([
      [], // no duplicate groups
      [{ c: 0n }], // no un-normalized rows
      [], // no unlinked tickets
      [{ c: 0n }], // ambiguous total
      [{ c: 0n }], // orphan total
    ]);
    const a = await auditUserEmailOwnership(client);
    expect(a.clean).toBe(true);
    expect(a.totals).toEqual({
      duplicateGroups: 0,
      ambiguousGroups: 0,
      ambiguousTickets: 0,
      unlinkedTickets: 0,
      unnormalizedRows: 0,
    });
  });

  it('flags an ambiguous duplicate group and splits tickets into ambiguous vs orphan', async () => {
    const client = mockClient([
      [
        { norm: 'shared@x.io', row_count: 2n, user_count: 2n, user_ids: [1, 2] }, // ambiguous
        { norm: 'variant@x.io', row_count: 2n, user_count: 1n, user_ids: [3] }, // same user
      ],
      [{ c: 2n }], // 2 rows still un-normalized (the ambiguous group collided)
      [
        { ticketId: 10, mask: 'TT-000010', email: 'shared@x.io', user_count: 2n }, // ambiguous
        { ticketId: 11, mask: 'TT-000011', email: 'ghost@x.io', user_count: 0n }, // orphan
      ],
      [{ c: 1n }], // ambiguous total
      [{ c: 1n }], // orphan total
    ]);
    const a = await auditUserEmailOwnership(client);

    expect(a.totals.duplicateGroups).toBe(2);
    expect(a.totals.ambiguousGroups).toBe(1); // only user_count > 1 counts
    expect(a.ambiguousTickets).toHaveLength(1);
    expect(a.ambiguousTickets[0].mask).toBe('TT-000010');
    expect(a.unlinkedTickets).toHaveLength(1);
    expect(a.unlinkedTickets[0].mask).toBe('TT-000011');
    // Not clean: an ambiguous group + un-normalized rows remain.
    expect(a.clean).toBe(false);
  });

  it('is NOT clean while un-normalized rows remain even with no ambiguous groups', async () => {
    const client = mockClient([
      [{ norm: 'a@x.io', row_count: 2n, user_count: 1n, user_ids: [5] }], // variants only
      [{ c: 1n }], // one un-normalized row remains
      [],
      [{ c: 0n }],
      [{ c: 0n }],
    ]);
    const a = await auditUserEmailOwnership(client);
    expect(a.totals.ambiguousGroups).toBe(0);
    expect(a.clean).toBe(false); // un-normalized rows still block the UNIQUE invariant
  });
});
