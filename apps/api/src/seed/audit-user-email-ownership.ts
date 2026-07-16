/**
 * GOAL_PUBLIC_SECURITY S2-2 — ownership audit ("manual-resolution report").
 *
 * READ-ONLY. Surfaces the data that must be resolved by a human BEFORE the DB-level
 * case-insensitive UNIQUE(email) invariant can be enforced, and reports which legacy
 * tickets could not be auto-linked to an owner:
 *
 *   1. Case-insensitive duplicate UserEmail groups (same normalized address on >1 row).
 *      - user_count > 1  → AMBIGUOUS ownership; blocks the unique invariant.
 *      - user_count == 1 → same user with case/whitespace variants; safe to de-dupe.
 *   2. UserEmail rows still not normalized (left un-normalized by the S2-2 migration
 *      because normalizing them would collide — i.e. members of an ambiguous group).
 *   3. Ambiguous tickets: userId IS NULL and the requester email maps to >1 user.
 *   4. Unlinked tickets: userId IS NULL and the requester email maps to 0 users.
 *
 * Contains customer email addresses (PII, not secrets) — it is an operator tool; run it
 * on the VM against production data. Run standalone: `npm run audit:ownership -w apps/api`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** How many example rows to include per category (counts are always exact). */
const SAMPLE_LIMIT = 500;

export interface DuplicateEmailGroup {
  email: string;
  rowCount: number;
  userCount: number;
  userIds: number[];
}
export interface TicketRef {
  ticketId: number;
  mask: string;
  email: string;
  userCount: number;
}
export interface OwnershipAudit {
  duplicateEmailGroups: DuplicateEmailGroup[];
  unnormalizedRowCount: number;
  ambiguousTickets: TicketRef[];
  unlinkedTickets: TicketRef[];
  totals: {
    duplicateGroups: number;
    ambiguousGroups: number;
    ambiguousTickets: number;
    unlinkedTickets: number;
    unnormalizedRows: number;
  };
  clean: boolean;
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

export async function auditUserEmailOwnership(client: PrismaClient = prisma): Promise<OwnershipAudit> {
  // 1. Case-insensitive duplicate UserEmail groups.
  const dupRows = await client.$queryRaw<
    { norm: string; row_count: bigint; user_count: bigint; user_ids: number[] }[]
  >`
    SELECT lower(btrim("email")) AS norm,
           count(*)              AS row_count,
           count(DISTINCT "userId") AS user_count,
           array_agg(DISTINCT "userId" ORDER BY "userId") AS user_ids
    FROM "UserEmail"
    GROUP BY lower(btrim("email"))
    HAVING count(*) > 1
    ORDER BY count(DISTINCT "userId") DESC, count(*) DESC
    LIMIT ${SAMPLE_LIMIT}
  `;
  const duplicateEmailGroups: DuplicateEmailGroup[] = dupRows.map((r) => ({
    email: r.norm,
    rowCount: num(r.row_count),
    userCount: num(r.user_count),
    userIds: r.user_ids,
  }));
  const ambiguousGroups = duplicateEmailGroups.filter((g) => g.userCount > 1).length;

  // 2. UserEmail rows still not normalized (collided during the migration).
  const [{ c: unnormalizedRowCount }] = await client.$queryRaw<{ c: bigint }[]>`
    SELECT count(*) AS c FROM "UserEmail" WHERE "email" <> lower(btrim("email"))
  `;

  // 3 + 4. Unlinked tickets, split into ambiguous (email → >1 user) and unlinked (→ 0 users).
  const ticketRows = await client.$queryRaw<
    { ticketId: number; mask: string; email: string; user_count: bigint }[]
  >`
    SELECT t."id" AS "ticketId",
           t."mask" AS mask,
           lower(btrim(t."requesterEmail")) AS email,
           (SELECT count(DISTINCT ue."userId") FROM "UserEmail" ue
            WHERE lower(btrim(ue."email")) = lower(btrim(t."requesterEmail"))) AS user_count
    FROM "Ticket" t
    WHERE t."userId" IS NULL AND btrim(t."requesterEmail") <> ''
    ORDER BY t."id"
    LIMIT ${SAMPLE_LIMIT}
  `;
  const ambiguousTickets: TicketRef[] = [];
  const unlinkedTickets: TicketRef[] = [];
  for (const r of ticketRows) {
    const ref: TicketRef = {
      ticketId: r.ticketId,
      mask: r.mask,
      email: r.email,
      userCount: num(r.user_count),
    };
    if (ref.userCount > 1) ambiguousTickets.push(ref);
    else unlinkedTickets.push(ref);
  }

  // Exact totals (not limited by SAMPLE_LIMIT).
  const [{ c: ambiguousTicketTotal }] = await client.$queryRaw<{ c: bigint }[]>`
    SELECT count(*) AS c FROM "Ticket" t
    WHERE t."userId" IS NULL AND btrim(t."requesterEmail") <> ''
      AND (SELECT count(DISTINCT ue."userId") FROM "UserEmail" ue
           WHERE lower(btrim(ue."email")) = lower(btrim(t."requesterEmail"))) > 1
  `;
  const [{ c: unlinkedTicketTotal }] = await client.$queryRaw<{ c: bigint }[]>`
    SELECT count(*) AS c FROM "Ticket" t
    WHERE t."userId" IS NULL AND btrim(t."requesterEmail") <> ''
      AND (SELECT count(DISTINCT ue."userId") FROM "UserEmail" ue
           WHERE lower(btrim(ue."email")) = lower(btrim(t."requesterEmail"))) = 0
  `;

  const totals = {
    duplicateGroups: duplicateEmailGroups.length,
    ambiguousGroups,
    ambiguousTickets: num(ambiguousTicketTotal),
    unlinkedTickets: num(unlinkedTicketTotal),
    unnormalizedRows: num(unnormalizedRowCount),
  };

  return {
    duplicateEmailGroups,
    unnormalizedRowCount: num(unnormalizedRowCount),
    ambiguousTickets,
    unlinkedTickets,
    totals,
    // "clean" ⇒ the DB-level case-insensitive UNIQUE(email) invariant can be enforced safely.
    clean: ambiguousGroups === 0 && totals.unnormalizedRows === 0,
  };
}

function printReport(a: OwnershipAudit): void {
  console.log('\n=== S2-2 UserEmail ownership audit ===');
  console.log(
    `duplicate email groups: ${a.totals.duplicateGroups} ` +
      `(ambiguous, >1 user: ${a.totals.ambiguousGroups})`,
  );
  console.log(`UserEmail rows still un-normalized (collided): ${a.totals.unnormalizedRows}`);
  console.log(`unlinked tickets — ambiguous (email → >1 user): ${a.totals.ambiguousTickets}`);
  console.log(`unlinked tickets — orphan   (email → 0 users):  ${a.totals.unlinkedTickets}`);

  if (a.duplicateEmailGroups.length) {
    console.log('\n-- duplicate email groups (resolve before enforcing UNIQUE) --');
    for (const g of a.duplicateEmailGroups) {
      const tag = g.userCount > 1 ? 'AMBIGUOUS' : 'variants';
      console.log(`  [${tag}] ${g.email} — rows=${g.rowCount} users=${g.userIds.join(',')}`);
    }
  }
  if (a.ambiguousTickets.length) {
    console.log('\n-- ambiguous tickets (email owned by multiple users) --');
    for (const t of a.ambiguousTickets) {
      console.log(`  ${t.mask} (#${t.ticketId}) — ${t.email} → ${t.userCount} users`);
    }
  }
  if (a.unlinkedTickets.length) {
    console.log('\n-- orphan tickets (email not registered to any user) --');
    for (const t of a.unlinkedTickets) {
      console.log(`  ${t.mask} (#${t.ticketId}) — ${t.email}`);
    }
  }
  console.log(
    `\n${a.clean ? 'CLEAN — the case-insensitive UNIQUE(email) invariant can be enforced.' : 'NOT CLEAN — resolve the groups above before enforcing UNIQUE(email).'}\n`,
  );
}

// Run standalone.
if (require.main === module) {
  auditUserEmailOwnership()
    .then(printReport)
    .catch((err: unknown) => {
      console.error('Ownership audit error:', err);
      process.exit(1);
    })
    .finally(() => void prisma.$disconnect());
}
