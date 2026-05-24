/**
 * Kayako Classic → 23 Telecom: SAMPLED ticket + post importer (idempotent).
 *
 *   tsx scripts/import-kayako-tickets.ts <sample_tickets.sql>
 *
 * Companion to import-kayako.ts. Run AFTER the core import (orgs/users/macros)
 * so requesters resolve by kayakoId. Imports swtickets→Ticket and
 * swticketposts→TicketPost for whatever tickets are present in the dump
 * (a balanced 5–20 row sample across statuses, produced via mysqldump --where).
 *
 * Kayako has 8 statuses / its own priority+type+dept vocab; the product seeds a
 * different set, so we map by the DENORMALIZED title columns stored on each
 * swtickets row (ticketstatustitle/prioritytitle/tickettypetitle/departmenttitle).
 * Idempotent: tickets upsert by Ticket.kayakoId; posts are replaced per ticket.
 * Internal (isprivate=1) posts are SKIPPED — the product TicketPost is the public
 * thread; importing private staff notes there would leak internal commentary.
 */
import { readFileSync, existsSync } from 'node:fs';
import { PrismaClient, ActorType, CreationMode } from '@prisma/client';
import { parseTable, datelineToDate } from '../src/migration/kayako-parser';

const prisma = new PrismaClient();

// Kayako status title → product status title.
const STATUS_MAP: Record<string, string> = {
  Initial: 'Open',
  'In Progress': 'In Progress',
  'Reply Received': 'Open',
  'Pending Vendor': 'Pending',
  'Pending Customer': 'Pending',
  'Forwarded to vendor': 'Pending',
  Escalated: 'In Progress',
  Closed: 'Closed',
};
const PRIORITY_MAP: Record<string, string> = { Low: 'Low', Normal: 'Normal', High: 'High', Urgent: 'Urgent' };
const TYPE_MAP: Record<string, string> = {
  'Customer Issue': 'Issue',
  'Vendor Issue': 'Incident',
  'Rate Notification': 'Question',
};

async function main(): Promise<void> {
  const dumpPath = process.argv[2];
  if (!dumpPath || !existsSync(dumpPath)) {
    console.error('Usage: tsx scripts/import-kayako-tickets.ts <sample_tickets.sql>');
    process.exit(1);
  }
  const sql = readFileSync(dumpPath, 'utf8');

  // Resolve product reference ids by title.
  const [statuses, priorities, types, depts, users] = await Promise.all([
    prisma.ticketStatus.findMany({ select: { id: true, title: true } }),
    prisma.ticketPriority.findMany({ select: { id: true, title: true } }),
    prisma.ticketType.findMany({ select: { id: true, title: true } }),
    prisma.department.findMany({ select: { id: true, title: true, isDefault: true } }),
    prisma.user.findMany({ where: { kayakoId: { not: null } }, select: { id: true, kayakoId: true } }),
  ]);
  const idByTitle = (arr: Array<{ id: number; title: string }>) => new Map(arr.map((x) => [x.title, x.id]));
  const stMap = idByTitle(statuses);
  const prMap = idByTitle(priorities);
  const tyMap = idByTitle(types);
  const deptMap = idByTitle(depts);
  const defaultDeptId = (depts.find((d) => d.isDefault) ?? depts[0]).id;
  const userByKayako = new Map(users.map((u) => [u.kayakoId as number, u.id]));

  const resolveStatus = (t: string | null): number =>
    stMap.get(STATUS_MAP[t ?? ''] ?? 'Open') ?? stMap.get('Open') ?? statuses[0].id;
  const resolvePriority = (t: string | null): number =>
    prMap.get(PRIORITY_MAP[t ?? ''] ?? 'Normal') ?? prMap.get('Normal') ?? priorities[0].id;
  const resolveType = (t: string | null): number | null => tyMap.get(TYPE_MAP[t ?? ''] ?? 'Issue') ?? null;
  // Kayako's single "General" dept → product default (Support).
  const resolveDept = (t: string | null): number => deptMap.get(t ?? '') ?? defaultDeptId;

  const ticketsT = parseTable(sql, 'swtickets');
  const postsT = parseTable(sql, 'swticketposts');

  const ticketIdByKayako = new Map<number, number>();
  let tCount = 0;
  for (const row of ticketsT.rows) {
    const kid = Number(row['ticketid']);
    if (!kid) continue;
    const statusTitle = row['ticketstatustitle'];
    const data = {
      mask: 'TT-' + String(kid).padStart(6, '0'),
      subject: (row['subject'] ?? '').trim() || '(no subject)',
      departmentId: resolveDept(row['departmenttitle']),
      statusId: resolveStatus(statusTitle),
      priorityId: resolvePriority(row['prioritytitle']),
      typeId: resolveType(row['tickettypetitle']),
      userId: userByKayako.get(Number(row['userid'])) ?? null,
      requesterName: row['fullname'] ?? '',
      requesterEmail: (row['email'] ?? '').trim().toLowerCase(),
      creationMode: CreationMode.EMAIL,
      creator: ActorType.USER,
      isResolved: statusTitle === 'Closed',
      isEscalated: statusTitle === 'Escalated',
      totalReplies: Number(row['totalreplies']) || 0,
      ipAddress: row['ipaddress'] || '0.0.0.0',
      messageId: row['messageid'] ?? '',
      createdAt: datelineToDate(row['dateline'] ?? null),
      lastReplyAt: datelineToDate(row['lastactivity'] ?? row['dateline'] ?? null),
    };
    const t = await prisma.ticket.upsert({
      where: { kayakoId: kid },
      create: { kayakoId: kid, ...data },
      update: data,
    });
    ticketIdByKayako.set(kid, t.id);
    tCount++;
  }

  // Posts: replace per imported ticket (idempotent re-run), skip internal notes.
  for (const tid of ticketIdByKayako.values()) {
    await prisma.ticketPost.deleteMany({ where: { ticketId: tid } });
  }
  let pCount = 0;
  let skippedPrivate = 0;
  for (const row of postsT.rows) {
    const tid = ticketIdByKayako.get(Number(row['ticketid']));
    if (!tid) continue;
    if (row['isprivate'] === '1') {
      skippedPrivate++;
      continue;
    }
    const isStaff = Number(row['staffid']) > 0;
    await prisma.ticketPost.create({
      data: {
        ticketId: tid,
        authorType: isStaff ? ActorType.STAFF : ActorType.USER,
        userId: isStaff ? null : (userByKayako.get(Number(row['userid'])) ?? null),
        fullName: row['fullname'] ?? '',
        email: (row['email'] ?? '').trim().toLowerCase(),
        subject: row['subject'] ?? '',
        contents: row['contents'] ?? '',
        isHtml: row['ishtml'] === '1',
        isEmailed: row['isemailed'] === '1',
        isThirdParty: row['isthirdparty'] === '1',
        creationMode: CreationMode.EMAIL,
        ipAddress: row['ipaddress'] || '0.0.0.0',
        createdAt: datelineToDate(row['dateline'] ?? null),
      },
    });
    pCount++;
  }

  // TAGS: swtaglinks(linktype=1, linkid=ticketid) → swtags.tagname → connect to the ticket (m2m).
  const tagNameById = new Map<number, string>();
  for (const r of parseTable(sql, 'swtags').rows) {
    const nm = (r['tagname'] ?? '').trim();
    if (nm) tagNameById.set(Number(r['tagid']), nm);
  }
  // Seed the FULL Kayako tag vocabulary (all swtags) so the product has the complete tag list,
  // not just the few used by the sampled tickets.
  const allTagNames = [...new Set(tagNameById.values())];
  if (allTagNames.length)
    await prisma.ticketTag.createMany({ data: allTagNames.map((name) => ({ name })), skipDuplicates: true });

  const tagsByTicket = new Map<number, Set<string>>();
  for (const r of parseTable(sql, 'swtaglinks').rows) {
    if (r['linktype'] !== '1') continue;
    const tid = ticketIdByKayako.get(Number(r['linkid']));
    const nm = tagNameById.get(Number(r['tagid']));
    if (!tid || !nm) continue;
    if (!tagsByTicket.has(tid)) tagsByTicket.set(tid, new Set());
    tagsByTicket.get(tid)!.add(nm);
  }
  let tagCount = 0;
  for (const [tid, names] of tagsByTicket) {
    await prisma.ticket.update({
      where: { id: tid },
      data: { tags: { connectOrCreate: [...names].map((name) => ({ where: { name }, create: { name } })) } },
    });
    tagCount += names.size;
  }

  // NOTES: swticketnotes(linktype=1, linktypeid=ticketid).note → internal note (replace per ticket = idempotent).
  for (const tid of ticketIdByKayako.values())
    await prisma.ticketNote.deleteMany({ where: { ticketId: tid } });
  let noteCount = 0;
  for (const r of parseTable(sql, 'swticketnotes').rows) {
    if (r['linktype'] !== '1') continue;
    const tid = ticketIdByKayako.get(Number(r['linktypeid']));
    const contents = (r['note'] ?? '').trim();
    if (!tid || !contents) continue;
    await prisma.ticketNote.create({
      data: { ticketId: tid, contents, createdAt: datelineToDate(r['dateline'] ?? null) },
    });
    noteCount++;
  }

  console.log(
    `✅ imported ${tCount} tickets, ${pCount} posts (${skippedPrivate} private skipped), ${tagCount} tag-links, ${noteCount} notes.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
