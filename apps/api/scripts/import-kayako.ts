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
  groupUserEmails,
  mapQueueType,
  mapRuleOp,
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

/**
 * Import swusers→User (no passwords — legacy SHA1 is dropped, users reset on
 * first login), swuseremails→UserEmail (linktype=1 only; linktype=2 are org
 * emails), and the single swusernote→User.customFields (we have no UserNote model).
 */
async function importUsers(
  usersT: ParsedTable,
  emailsT: ParsedTable,
  linksT: ParsedTable,
  notesT: ParsedTable,
  noteDataT: ParsedTable,
  ids: IdMap,
): Promise<void> {
  // userId → primary orgId fallback from the multi-org link table.
  const linkOrg = new Map<number, number>();
  for (const r of linksT.rows) {
    const uid = Number(r['userid']);
    if (!linkOrg.has(uid)) linkOrg.set(uid, Number(r['userorganizationid']));
  }

  let imported = 0;
  for (const row of usersT.rows) {
    const kayakoId = Number(row['userid']);
    const orgKayako = Number(row['userorganizationid']) || linkOrg.get(kayakoId) || 0;
    const organizationId = ids.get('swuserorganizations', orgKayako) ?? null;
    const data = {
      fullName: row['fullname'] || `User ${kayakoId}`,
      phone: row['phone'] ?? '',
      designation: row['userdesignation'] ?? '',
      isEnabled: row['isenabled'] === '1',
      isValidated: Number(row['isvalidated']) > 0,
      timezone: row['timezonephp'] || 'UTC',
      organizationId,
      createdAt: datelineToDate(row['dateline'] ?? null),
      // passwordHash intentionally left null — no legacy password migration.
    };
    const user = await prisma.user.upsert({
      where: { kayakoId },
      create: { kayakoId, ...data },
      update: data,
    });
    ids.set('swusers', kayakoId, user.id);
    imported++;
  }

  // Emails: group user-linked (linktype=1) rows by userId; mark first primary if none.
  const byUser = groupUserEmails(emailsT.rows);
  let emailCount = 0;
  for (const [uid, list] of byUser) {
    const userId = ids.get('swusers', uid);
    if (!userId) continue; // user not in this (sampled) dump
    for (const e of list) {
      await prisma.userEmail.upsert({
        where: { email: e.email },
        create: { email: e.email, isPrimary: e.isPrimary, userId },
        update: { isPrimary: e.isPrimary, userId },
      });
      emailCount++;
    }
  }

  // User notes → User.customFields.notes (no dedicated model; only 1 in the dump).
  const noteText = new Map<number, string>();
  for (const d of noteDataT.rows) noteText.set(Number(d['usernoteid']), d['notecontents'] ?? '');
  let noteCount = 0;
  for (const n of notesT.rows) {
    if (n['linktype'] !== '1') continue;
    const userId = ids.get('swusers', Number(n['linktypeid']));
    if (!userId) continue;
    const contents = noteText.get(Number(n['usernoteid'])) ?? '';
    if (!contents) continue;
    const note = {
      by: n['staffname'] ?? '',
      at: datelineToDate(n['dateline'] ?? null).toISOString(),
      contents,
    };
    const current = await prisma.user.findUnique({ where: { id: userId }, select: { customFields: true } });
    const cf = (current?.customFields as Record<string, unknown>) ?? {};
    const notes = Array.isArray(cf['notes']) ? (cf['notes'] as unknown[]) : [];
    // Idempotent: replace any prior import-sourced notes rather than appending dupes.
    await prisma.user.update({
      where: { id: userId },
      data: {
        customFields: {
          ...cf,
          notes: [...notes.filter((x) => (x as { contents?: string }).contents !== contents), note],
        },
      },
    });
    noteCount++;
  }

  console.log(`  → imported ${imported} users, ${emailCount} emails, ${noteCount} notes`);
}

/**
 * Import swemailqueues→EmailQueue and swparserrules(+criteria+actions)→
 * EmailParserRule. Passwords are NOT migrated (Kayako encrypts with a key we
 * don't have) — queues import DISABLED with an empty passwordEnc; an admin sets
 * the password and re-enables. The 3 enabled bounce-ignore rules are critical
 * (mail-loop prevention) so they import as PRE_PARSE + {type:'ignore'}.
 */
async function importEmailConfig(
  queuesT: ParsedTable,
  rulesT: ParsedTable,
  criteriaT: ParsedTable,
  actionsT: ParsedTable,
): Promise<void> {
  const defaultDept = await prisma.department.findFirst({ where: { isDefault: true }, select: { id: true } });

  let qCount = 0;
  for (const row of queuesT.rows) {
    const emailAddress = (row['email'] ?? '').trim().toLowerCase();
    if (!emailAddress) continue;
    const data = {
      type: mapQueueType(row['fetchtype'] ?? row['type']),
      emailAddress,
      host: row['host'] ?? '',
      port: Number(row['port']) || 993,
      username: row['username'] ?? '',
      // Password not migrated — Kayako's encryption key is unavailable.
      passwordEnc: '',
      sendAutoresponder: row['ticketautoresponder'] === '1',
      departmentId: defaultDept?.id ?? null,
      // Import disabled (no password) so the poller doesn't try to connect.
      isEnabled: false,
    };
    // D5: atomic upsert on the unique emailAddress (was a non-atomic
    // findFirst+create that could race / double-insert on re-run).
    await prisma.emailQueue.upsert({
      where: { emailAddress },
      update: data,
      create: data,
    });
    qCount++;
  }

  // Group criteria/actions by parserruleid.
  const critByRule = new Map<number, Array<{ field: string; op: string; value: string }>>();
  for (const c of criteriaT.rows) {
    const rid = Number(c['parserruleid']);
    if (!critByRule.has(rid)) critByRule.set(rid, []);
    critByRule.get(rid)!.push({
      field: c['name'] ?? 'subject',
      op: mapRuleOp(c['ruleop']),
      value: c['rulematch'] ?? '',
    });
  }
  const actByRule = new Map<number, Array<{ type: string; value?: string }>>();
  for (const a of actionsT.rows) {
    const rid = Number(a['parserruleid']);
    if (!actByRule.has(rid)) actByRule.set(rid, []);
    actByRule.get(rid)!.push({ type: a['name'] ?? 'ignore', value: a['typedata'] || undefined });
  }

  let rCount = 0;
  for (const row of rulesT.rows) {
    const kid = Number(row['parserruleid']);
    const data = {
      title: row['title'] ?? `Rule ${kid}`,
      ruleType: row['ruletype'] === '2' ? ('POST_PARSE' as const) : ('PRE_PARSE' as const),
      matchType: row['matchtype'] === '3' ? ('ALL' as const) : ('ANY' as const),
      stopProcessing: row['stopprocessing'] === '1',
      isEnabled: row['isenabled'] === '1',
      sortOrder: Number(row['sortorder']) || 0,
      criteria: critByRule.get(kid) ?? [],
      actions: actByRule.get(kid) ?? [],
    };
    const existing = await prisma.emailParserRule.findFirst({ where: { title: data.title } });
    if (existing) await prisma.emailParserRule.update({ where: { id: existing.id }, data });
    else await prisma.emailParserRule.create({ data });
    rCount++;
  }

  console.log(`  → imported ${qCount} email queues (disabled, no password), ${rCount} parser rules`);
}

/**
 * Build kayakoId→ourId maps for the reference tables (status/priority/type/dept)
 * by matching TITLE to our seeded rows. Macro action FKs are resolved through
 * these (we look up reference data by title, never by Kayako id).
 */
async function buildReferenceMaps(sql: string, ids: IdMap): Promise<void> {
  const refs: Array<{
    table: string;
    idCol: string;
    titleCol: string;
    model: 'ticketStatus' | 'ticketPriority' | 'ticketType' | 'department';
  }> = [
    { table: 'swticketstatus', idCol: 'ticketstatusid', titleCol: 'title', model: 'ticketStatus' },
    { table: 'swticketpriorities', idCol: 'priorityid', titleCol: 'title', model: 'ticketPriority' },
    { table: 'swtickettypes', idCol: 'tickettypeid', titleCol: 'title', model: 'ticketType' },
    { table: 'swdepartments', idCol: 'departmentid', titleCol: 'title', model: 'department' },
  ];
  for (const r of refs) {
    const parsed = parseTable(sql, r.table);
    for (const row of parsed.rows) {
      const kid = Number(row[r.idCol]);
      const title = row[r.titleCol];
      if (!title) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ours = await (prisma as any)[r.model].findFirst({ where: { title }, select: { id: true } });
      if (ours) ids.set(r.table, kid, ours.id);
    }
  }
}

/** Import swmacrocategories→MacroCategory (hierarchy) then swmacroreplies→Macro. */
async function importMacros(
  catsT: ParsedTable,
  repliesT: ParsedTable,
  replyDataT: ParsedTable,
  ids: IdMap,
): Promise<void> {
  // Categories first (parents before children — sort by id ascending).
  const cats = [...catsT.rows].sort((a, b) => Number(a['macrocategoryid']) - Number(b['macrocategoryid']));
  let catCount = 0;
  for (const row of cats) {
    const kid = Number(row['macrocategoryid']);
    const title = row['title'] ?? `Category ${kid}`;
    const parentKid = Number(row['parentcategoryid']) || 0;
    const parentId = parentKid ? (ids.get('swmacrocategories', parentKid) ?? null) : null;
    const existing = await prisma.macroCategory.findFirst({ where: { title } });
    const cat = existing
      ? await prisma.macroCategory.update({ where: { id: existing.id }, data: { parentId } })
      : await prisma.macroCategory.create({ data: { title, parentId } });
    ids.set('swmacrocategories', kid, cat.id);
    catCount++;
  }

  // Reply bodies.
  const bodyByReply = new Map<number, string>();
  for (const d of replyDataT.rows) bodyByReply.set(Number(d['macroreplyid']), d['contents'] ?? '');

  // categorytype: 1=shared/public, 2=private (owner-only).
  const sharedByCat = new Map<number, boolean>();
  for (const row of catsT.rows) sharedByCat.set(Number(row['macrocategoryid']), row['categorytype'] !== '2');

  let mCount = 0;
  for (const row of repliesT.rows) {
    const kid = Number(row['macroreplyid']);
    const catKid = Number(row['macrocategoryid']);
    // Build actions from the inline FK columns (≠ -1), mapped via the ref maps.
    const actions: Array<{ type: string; value: string }> = [];
    const statusId = ids.get('swticketstatus', Number(row['ticketstatusid']));
    if (Number(row['ticketstatusid']) !== -1 && statusId)
      actions.push({ type: 'set_status', value: String(statusId) });
    const priorityId = ids.get('swticketpriorities', Number(row['priorityid']));
    if (Number(row['priorityid']) !== -1 && priorityId)
      actions.push({ type: 'set_priority', value: String(priorityId) });
    const deptId = ids.get('swdepartments', Number(row['departmentid']));
    if (Number(row['departmentid']) !== -1 && deptId)
      actions.push({ type: 'change_department', value: String(deptId) });

    const data = {
      categoryId: ids.get('swmacrocategories', catKid) ?? null,
      title: row['subject'] || `Macro ${kid}`,
      subject: row['subject'] ?? '',
      replyText: bodyByReply.get(kid) ?? '',
      isHtml: false,
      isShared: sharedByCat.get(catKid) ?? true,
      actions,
    };
    await prisma.macro.upsert({
      where: { kayakoId: kid },
      create: { kayakoId: kid, ...data },
      update: data,
    });
    mCount++;
  }

  console.log(`  → imported ${catCount} macro categories, ${mCount} macros`);
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
  const tables: Record<string, ParsedTable> = {};
  for (const table of DEPENDENCY_ORDER) {
    const parsed = parseTable(sql, table);
    tables[table] = parsed;
    const exp = expected.get(table);
    const note = exp != null ? ` (dump has ${parsed.rows.length}/${exp} expected)` : '';
    if (exp != null && parsed.rows.length < exp) sampled = true;
    console.log(`• ${table}: parsed ${parsed.rows.length} rows${note}`);
  }
  // Side tables (not in the logged dependency list).
  const orgLinks = parseTable(sql, 'swuserorganizationlinks');
  const userNotes = parseTable(sql, 'swusernotes');
  const userNoteData = parseTable(sql, 'swusernotedata');
  const ruleCriteria = parseTable(sql, 'swparserrulecriteria');
  const ruleActions = parseTable(sql, 'swparserruleactions');
  const macroCats = parseTable(sql, 'swmacrocategories');
  const macroReplyData = parseTable(sql, 'swmacroreplydata');

  // Import in dependency order.
  if (tables['swuserorganizations']?.rows.length) {
    await importOrganizations(tables['swuserorganizations'], ids);
  }
  if (tables['swusers']?.rows.length) {
    await importUsers(
      tables['swusers'],
      tables['swuseremails'] ?? { columns: [], rows: [] },
      orgLinks,
      userNotes,
      userNoteData,
      ids,
    );
  }
  if (tables['swemailqueues']?.rows.length || tables['swparserrules']?.rows.length) {
    await importEmailConfig(
      tables['swemailqueues'] ?? { columns: [], rows: [] },
      tables['swparserrules'] ?? { columns: [], rows: [] },
      ruleCriteria,
      ruleActions,
    );
  }
  if (tables['swmacroreplies']?.rows.length || macroCats.rows.length) {
    await buildReferenceMaps(sql, ids);
    await importMacros(macroCats, tables['swmacroreplies'] ?? { columns: [], rows: [] }, macroReplyData, ids);
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
