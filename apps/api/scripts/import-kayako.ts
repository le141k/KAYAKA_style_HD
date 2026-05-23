/**
 * Kayako Classic → 23 Telecom importer (idempotent, re-runnable).
 *
 *   tsx scripts/import-kayako.ts <dump.sql> [--inventory <tables_inventory.csv>]
 *
 * Run AFTER `npm run seed` (it imports ON TOP of the seeded reference data and
 * resolves status/priority/type/department by title, never by Kayako id).
 *
 * Design (per docs/GOAL_MIGRATION.md): parse raw mysqldump INSERTs, keep a
 * per-table oldKayakoId→newId map, upsert by a stored `kayakoId` (idempotent),
 * resolve FKs in dependency order, and detect full-dump vs the sampled subset.
 *
 * Pure parsing/classification lives in src/migration/kayako-parser.ts (so it's
 * type-checked + unit-tested). This runner adds the Prisma writes.
 *
 * M0 implements the framework + Organization import. swusers/emails/notes → M1;
 * email queues/parser rules → M2; macros → M4.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient, type OrgType } from '@prisma/client';
import {
  parseTable,
  datelineToDate,
  classifyOrg,
  IdMap,
  type ParsedTable,
} from '../src/migration/kayako-parser';

const prisma = new PrismaClient();

async function importOrganizations(parsed: ParsedTable, ids: IdMap): Promise<void> {
  const summary: Array<{ kayakoId: number; name: string; orgType: OrgType }> = [];
  for (const row of parsed.rows) {
    const kayakoId = Number(row['userorganizationid']);
    const name = row['organizationname'] ?? `Org ${kayakoId}`;
    const orgType = classifyOrg(name);
    const data = {
      orgType,
      name,
      address: row['address'] ?? '',
      city: row['city'] ?? '',
      state: row['state'] ?? '',
      postalCode: row['postalcode'] ?? '',
      country: row['country'] ?? '',
      phone: row['phone'] ?? '',
      website: row['website'] ?? '',
      createdAt: datelineToDate(row['dateline'] ?? null),
    };
    const org = await prisma.organization.upsert({
      where: { kayakoId },
      create: { kayakoId, ...data },
      update: data,
    });
    ids.set('swuserorganizations', kayakoId, org.id);
    summary.push({ kayakoId, name, orgType });
  }
  // The goal asks us to PRINT the org list with chosen orgType for human confirmation.
  console.log('\n=== Organizations (confirm orgType) ===');
  for (const s of summary) {
    console.log(`  [${s.orgType.padEnd(8)}] kayakoId=${s.kayakoId}  ${s.name}`);
  }
}

const DEPENDENCY_ORDER = [
  'swuserorganizations', // → Organization      (M0/M1)
  'swusers', // → User                          (M1)
  'swuseremails', // → UserEmail                (M1)
  'swusernotes', // → user notes                (M1)
  'swemailqueues', // → EmailQueue              (M2)
  'swparserrules', // → EmailParserRule         (M2)
  'swmacrocategories', // → MacroCategory        (M4)
  'swmacroreplies', // → Macro                  (M4)
];

async function main() {
  const dumpPath = process.argv[2];
  if (!dumpPath || !existsSync(dumpPath)) {
    console.error('Usage: tsx scripts/import-kayako.ts <dump.sql> [--inventory <csv>]');
    process.exit(1);
  }
  const invFlag = process.argv.indexOf('--inventory');
  const invPath = invFlag > -1 ? process.argv[invFlag + 1] : undefined;

  const sql = readFileSync(dumpPath, 'utf8');
  const ids = new IdMap();

  const expected = new Map<string, number>();
  if (invPath && existsSync(invPath)) {
    for (const line of readFileSync(invPath, 'utf8').split('\n').slice(1)) {
      const [t, c] = line.split(',');
      if (t) expected.set(t.trim(), Number(c));
    }
  }

  console.log(`Importing from ${dumpPath}`);
  let sampled = false;
  for (const table of DEPENDENCY_ORDER) {
    const parsed = parseTable(sql, table);
    const exp = expected.get(table);
    const note = exp != null ? ` (dump has ${parsed.rows.length}/${exp} expected)` : '';
    if (exp != null && parsed.rows.length < exp) sampled = true;
    console.log(`• ${table}: parsed ${parsed.rows.length} rows${note}`);

    if (table === 'swuserorganizations' && parsed.rows.length) {
      await importOrganizations(parsed, ids);
    }
    // swusers/emails/notes → M1; queues/parser → M2; macros → M4.
  }

  if (sampled) {
    console.log(
      '\n⚠️  SAMPLED DUMP DETECTED — at least one table has fewer rows than the inventory expects.\n' +
        '    A full mysqldump is required to migrate ALL clients/suppliers/users/macros.\n' +
        '    Imported the available subset; missing rows are logged above.',
    );
  }
  console.log('\n✅ Import run complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
