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
 *      because normalizing them would collide — i.e. members of a duplicate group).
 *   3. Unlinked tickets (userId IS NULL), split by how their requester email resolves:
 *      - >1 user → AMBIGUOUS (cannot auto-link),
 *      - 1 user  → LINKABLE (the S2-2 backfill links these; remaining ones are pre-migration
 *                  or post-crash), and
 *      - 0 users → ORPHAN (email registered to nobody).
 *
 * Contains customer email addresses (PII, not secrets) — it is an operator tool; run it
 * on the VM against production data. Run standalone: `npm run audit:ownership -w apps/api`.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** How many example rows to include per category (the `totals` counts are always exact). */
const SAMPLE_LIMIT = 500;

/**
 * ASCII whitespace set trimmed by `btrim()`, kept identical to JS `String.prototype.trim()`
 * (space, tab, LF, CR, FF, VT) so the DB and `normalizeEmail` agree on "normalized". Bound as a
 * query parameter so the exact byte set — not a shell/JS-escaping accident — reaches Postgres.
 */
const WS = ' \t\n\r\f\v';

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
  /** Samples (each capped at SAMPLE_LIMIT); use `totals` for exact counts. */
  duplicateEmailGroups: DuplicateEmailGroup[];
  ambiguousTickets: TicketRef[]; // email → >1 user
  linkableTickets: TicketRef[]; // email → exactly 1 user (backfill target)
  unlinkedTickets: TicketRef[]; // email → 0 users (orphan)
  totals: {
    duplicateGroups: number;
    ambiguousGroups: number;
    ambiguousTickets: number;
    linkableTickets: number;
    unlinkedTickets: number;
    unnormalizedRows: number;
  };
  clean: boolean;
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));

export async function auditUserEmailOwnership(client: PrismaClient = prisma): Promise<OwnershipAudit> {
  // 1. Case-insensitive duplicate UserEmail groups (sample).
  const dupRows = await client.$queryRaw<
    { norm: string; row_count: bigint; user_count: bigint; user_ids: number[] }[]
  >`
    SELECT lower(btrim("email", ${WS})) AS norm,
           count(*)                     AS row_count,
           count(DISTINCT "userId")     AS user_count,
           array_agg(DISTINCT "userId" ORDER BY "userId") AS user_ids
    FROM "UserEmail"
    -- GROUP BY the SELECT ordinal (1 = the norm expression), NOT a second interpolation of the
    -- whitespace set: each interpolation becomes a distinct bound parameter, so grouping by
    -- lower(btrim(email, $2)) would not match the SELECT lower(btrim(email, $1)) (Postgres 42803).
    GROUP BY 1
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

  // Exact group totals (not limited by SAMPLE_LIMIT).
  const [{ groups: dupGroupTotal, ambiguous: ambiguousGroupTotal }] = await client.$queryRaw<
    { groups: bigint; ambiguous: bigint }[]
  >`
    SELECT count(*) AS groups, count(*) FILTER (WHERE uc > 1) AS ambiguous
    FROM (
      SELECT count(DISTINCT "userId") AS uc
      FROM "UserEmail"
      GROUP BY lower(btrim("email", ${WS}))
      HAVING count(*) > 1
    ) g
  `;

  // 2. UserEmail rows still not normalized (collided during the migration).
  const [{ c: unnormalizedRowCount }] = await client.$queryRaw<{ c: bigint }[]>`
    SELECT count(*) AS c FROM "UserEmail" WHERE "email" <> lower(btrim("email", ${WS}))
  `;

  // 3. Unlinked tickets (sample), classified by how the requester email resolves.
  const ticketRows = await client.$queryRaw<
    { ticketId: number; mask: string; email: string; user_count: bigint }[]
  >`
    SELECT t."id" AS "ticketId",
           t."mask" AS mask,
           lower(btrim(t."requesterEmail", ${WS})) AS email,
           (SELECT count(DISTINCT ue."userId") FROM "UserEmail" ue
            WHERE lower(btrim(ue."email", ${WS})) = lower(btrim(t."requesterEmail", ${WS}))) AS user_count
    FROM "Ticket" t
    WHERE t."userId" IS NULL AND btrim(t."requesterEmail", ${WS}) <> ''
    ORDER BY t."id"
    LIMIT ${SAMPLE_LIMIT}
  `;
  const ambiguousTickets: TicketRef[] = [];
  const linkableTickets: TicketRef[] = [];
  const unlinkedTickets: TicketRef[] = [];
  for (const r of ticketRows) {
    const ref: TicketRef = {
      ticketId: r.ticketId,
      mask: r.mask,
      email: r.email,
      userCount: num(r.user_count),
    };
    if (ref.userCount > 1) ambiguousTickets.push(ref);
    else if (ref.userCount === 1) linkableTickets.push(ref);
    else unlinkedTickets.push(ref);
  }

  // Exact ticket totals in one pass (same predicate as the sample above).
  const [tt] = await client.$queryRaw<{ ambiguous: bigint; linkable: bigint; orphan: bigint }[]>`
    SELECT count(*) FILTER (WHERE uc > 1) AS ambiguous,
           count(*) FILTER (WHERE uc = 1) AS linkable,
           count(*) FILTER (WHERE uc = 0) AS orphan
    FROM (
      SELECT (SELECT count(DISTINCT ue."userId") FROM "UserEmail" ue
              WHERE lower(btrim(ue."email", ${WS})) = lower(btrim(t."requesterEmail", ${WS}))) AS uc
      FROM "Ticket" t
      WHERE t."userId" IS NULL AND btrim(t."requesterEmail", ${WS}) <> ''
    ) x
  `;

  const totals = {
    duplicateGroups: num(dupGroupTotal),
    ambiguousGroups: num(ambiguousGroupTotal),
    ambiguousTickets: num(tt.ambiguous),
    linkableTickets: num(tt.linkable),
    unlinkedTickets: num(tt.orphan),
    unnormalizedRows: num(unnormalizedRowCount),
  };

  return {
    duplicateEmailGroups,
    ambiguousTickets,
    linkableTickets,
    unlinkedTickets,
    totals,
    // "clean" ⇒ the DB-level case-insensitive UNIQUE(email) invariant can be enforced safely.
    // (linkable/orphan tickets do NOT block it — they are an ownership-completeness signal.)
    clean: totals.ambiguousGroups === 0 && totals.unnormalizedRows === 0,
  };
}

function printReport(a: OwnershipAudit): void {
  console.log('\n=== S2-2 UserEmail ownership audit ===');
  console.log(
    `duplicate email groups: ${a.totals.duplicateGroups} ` +
      `(ambiguous, >1 user: ${a.totals.ambiguousGroups})`,
  );
  console.log(`UserEmail rows still un-normalized (collided): ${a.totals.unnormalizedRows}`);
  console.log(`unlinked tickets — ambiguous (email → >1 user):   ${a.totals.ambiguousTickets}`);
  console.log(`unlinked tickets — linkable  (email → 1 user):    ${a.totals.linkableTickets}`);
  console.log(`unlinked tickets — orphan    (email → 0 users):   ${a.totals.unlinkedTickets}`);

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
  if (a.linkableTickets.length) {
    console.log('\n-- linkable tickets (email → 1 user; the migration backfills these) --');
    for (const t of a.linkableTickets) {
      console.log(`  ${t.mask} (#${t.ticketId}) — ${t.email}`);
    }
  }
  if (a.unlinkedTickets.length) {
    console.log('\n-- orphan tickets (email not registered to any user) --');
    for (const t of a.unlinkedTickets) {
      console.log(`  ${t.mask} (#${t.ticketId}) — ${t.email}`);
    }
  }
  console.log(
    `\n${a.clean ? 'CLEAN — the case-insensitive UNIQUE(email) invariant can be enforced.' : 'NOT CLEAN — resolve the duplicate/un-normalized rows above before enforcing UNIQUE(email).'}\n`,
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
