import { describe, it, expect, vi } from 'vitest';
import { auditUserEmailOwnership } from './audit-user-email-ownership';
import type { PrismaClient } from '@prisma/client';

/**
 * The audit issues five $queryRaw calls in this order:
 *   1. duplicate email groups (sample)
 *   2. exact group totals { groups, ambiguous }
 *   3. un-normalized row count { c }
 *   4. unlinked-ticket sample rows (split into ambiguous / linkable / orphan)
 *   5. exact ticket totals { ambiguous, linkable, orphan }
 */
function mockClient(seq: unknown[]): PrismaClient {
  const q = vi.fn();
  for (const v of seq) q.mockResolvedValueOnce(v);
  return { $queryRaw: q } as unknown as PrismaClient;
}

describe('auditUserEmailOwnership (S2-2)', () => {
  it('reports CLEAN when there are no duplicates, un-normalized rows or unlinked tickets', async () => {
    const client = mockClient([
      [], // no duplicate groups (sample)
      [{ groups: 0n, ambiguous: 0n }], // exact group totals
      [{ c: 0n }], // no un-normalized rows
      [], // no unlinked tickets (sample)
      [{ ambiguous: 0n, linkable: 0n, orphan: 0n }], // exact ticket totals
    ]);
    const a = await auditUserEmailOwnership(client);
    expect(a.clean).toBe(true);
    expect(a.totals).toEqual({
      duplicateGroups: 0,
      ambiguousGroups: 0,
      ambiguousTickets: 0,
      linkableTickets: 0,
      unlinkedTickets: 0,
      unnormalizedRows: 0,
    });
  });

  it('splits tickets into ambiguous / linkable / orphan and keeps sample consistent with totals', async () => {
    const client = mockClient([
      [
        { norm: 'shared@x.io', row_count: 2n, user_count: 2n, user_ids: [1, 2] }, // ambiguous
        { norm: 'variant@x.io', row_count: 2n, user_count: 1n, user_ids: [3] }, // same user
      ],
      [{ groups: 2n, ambiguous: 1n }], // exact group totals
      [{ c: 2n }], // un-normalized rows
      [
        { ticketId: 10, mask: 'TT-000010', email: 'shared@x.io', user_count: 2n }, // ambiguous
        { ticketId: 11, mask: 'TT-000011', email: 'one@x.io', user_count: 1n }, // linkable
        { ticketId: 12, mask: 'TT-000012', email: 'ghost@x.io', user_count: 0n }, // orphan
      ],
      [{ ambiguous: 1n, linkable: 1n, orphan: 1n }], // exact ticket totals
    ]);
    const a = await auditUserEmailOwnership(client);

    expect(a.totals.duplicateGroups).toBe(2);
    expect(a.totals.ambiguousGroups).toBe(1); // only user_count > 1 counts

    // Every sampled ticket lands in exactly one bucket, and each bucket's sample size
    // matches its exact total (the userCount===1 case is no longer silently dropped).
    expect(a.ambiguousTickets.map((t) => t.mask)).toEqual(['TT-000010']);
    expect(a.linkableTickets.map((t) => t.mask)).toEqual(['TT-000011']);
    expect(a.unlinkedTickets.map((t) => t.mask)).toEqual(['TT-000012']);
    expect(a.totals.ambiguousTickets).toBe(1);
    expect(a.totals.linkableTickets).toBe(1);
    expect(a.totals.unlinkedTickets).toBe(1);

    expect(a.clean).toBe(false); // ambiguous group + un-normalized rows remain
  });

  it('is NOT clean while un-normalized rows remain even with no ambiguous groups', async () => {
    const client = mockClient([
      [{ norm: 'a@x.io', row_count: 2n, user_count: 1n, user_ids: [5] }], // variants only
      [{ groups: 1n, ambiguous: 0n }],
      [{ c: 1n }], // one un-normalized row remains
      [],
      [{ ambiguous: 0n, linkable: 0n, orphan: 0n }],
    ]);
    const a = await auditUserEmailOwnership(client);
    expect(a.totals.ambiguousGroups).toBe(0);
    expect(a.clean).toBe(false); // un-normalized rows still block the UNIQUE invariant
  });
});
