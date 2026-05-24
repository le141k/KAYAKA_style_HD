/**
 * M3 demo data — the 23T linked-pair model with real-looking SMS-routing content.
 *
 *   tsx scripts/seed-demo-pairs.ts        (run after `npm run seed`)
 *
 * For EACH of the 8 ticket statuses it creates 5–15 CLIENT tickets (type Customer
 * Issue, requester = a customer, thread = customer ↔ 23T), and for each one a
 * LINKED SUPPLIER ticket (type Vendor Issue, requester = a carrier, thread =
 * 23T ↔ vendor with isThirdParty), joined by a TicketLink (linkType=supplier).
 *
 * Idempotent: every generated ticket is marked `customFields.demoPair=true`; a
 * re-run deletes the previous demo pairs (TicketLink/TicketPost cascade) first.
 */
import { PrismaClient, type Prisma } from '@prisma/client';

const prisma = new PrismaClient();

// The 8 statuses of the 23T workflow (5 seeded + 3 added here).
const STATUS_DEFS = [
  { title: 'Initial', markAsResolved: false },
  { title: 'Open', markAsResolved: false },
  { title: 'In Progress', markAsResolved: false },
  { title: 'Pending', markAsResolved: false },
  { title: 'Pending Vendor', markAsResolved: false },
  { title: 'Reply Received', markAsResolved: false },
  { title: 'Resolved', markAsResolved: true },
  { title: 'Closed', markAsResolved: true },
];

const CARRIERS = [
  { org: 'Sinch', email: 'noc@sinch.com', name: 'Sinch NOC' },
  { org: 'Lleida', email: 'support@lleida.net', name: 'Lleida Support' },
  { org: 'Broadnet', email: 'noc@broadnet.com', name: 'Broadnet NOC' },
];
const CUSTOMERS = [
  { org: 'Acme Retail', email: 'ops@acme-retail.example', name: 'Acme Ops' },
  { org: 'Globex Bank', email: 'sms@globex-bank.example', name: 'Globex SMS Team' },
  { org: 'Initech', email: 'alerts@initech.example', name: 'Initech Alerts' },
  { org: 'Umbrella Health', email: 'otp@umbrella-health.example', name: 'Umbrella OTP' },
];
const DESTINATIONS = ['ES', 'DE', 'FR', 'UK', 'IT', 'PL', 'NL', 'SE'];

function rand<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function ensureStatus(title: string, markAsResolved: boolean): Promise<number> {
  const existing = await prisma.ticketStatus.findFirst({ where: { title } });
  if (existing) return existing.id;
  const created = await prisma.ticketStatus.create({
    data: { title, markAsResolved, isDefault: false, displayOrder: 50, color: '#ffffff', bgColor: '#6b7280' },
  });
  return created.id;
}

async function ensureType(title: string): Promise<number> {
  const existing = await prisma.ticketType.findFirst({ where: { title } });
  if (existing) return existing.id;
  const created = await prisma.ticketType.create({ data: { title, displayOrder: 50 } });
  return created.id;
}

async function ensureOrg(name: string, orgType: 'CLIENT' | 'SUPPLIER'): Promise<number> {
  const existing = await prisma.organization.findFirst({ where: { name } });
  if (existing) {
    if (existing.orgType !== orgType) {
      await prisma.organization.update({ where: { id: existing.id }, data: { orgType } });
    }
    return existing.id;
  }
  const created = await prisma.organization.create({ data: { name, orgType } });
  return created.id;
}

async function ensureUser(email: string, fullName: string, organizationId: number): Promise<number> {
  const existing = await prisma.userEmail.findUnique({ where: { email }, select: { userId: true } });
  if (existing) return existing.userId;
  const user = await prisma.user.create({
    data: { fullName, organizationId, emails: { create: { email, isPrimary: true } } },
  });
  return user.id;
}

interface PostInput {
  authorType: 'USER' | 'STAFF';
  staffId?: number;
  userId?: number;
  fullName: string;
  email: string;
  contents: string;
  isThirdParty?: boolean;
  createdAt: Date;
}

async function createTicket(opts: {
  subject: string;
  departmentId: number;
  statusId: number;
  priorityId: number;
  typeId: number;
  requesterEmail: string;
  requesterName: string;
  userId: number;
  ownerStaffId: number;
  createdAt: Date;
  posts: PostInput[];
}): Promise<{ id: number; mask: string }> {
  const t = await prisma.ticket.create({
    data: {
      mask: 'TT-PENDING',
      subject: opts.subject,
      departmentId: opts.departmentId,
      statusId: opts.statusId,
      priorityId: opts.priorityId,
      typeId: opts.typeId,
      userId: opts.userId,
      requesterEmail: opts.requesterEmail,
      requesterName: opts.requesterName,
      ownerStaffId: opts.ownerStaffId,
      creationMode: 'EMAIL',
      creator: 'USER',
      createdAt: opts.createdAt,
      lastActivityAt: opts.posts[opts.posts.length - 1]?.createdAt ?? opts.createdAt,
      totalReplies: opts.posts.length,
      customFields: { demoPair: true } as Prisma.InputJsonValue,
      posts: {
        create: opts.posts.map((p) => ({
          authorType: p.authorType,
          staffId: p.staffId,
          userId: p.userId,
          fullName: p.fullName,
          email: p.email,
          subject: opts.subject,
          contents: p.contents,
          isHtml: false,
          isThirdParty: p.isThirdParty ?? false,
          creationMode: 'EMAIL',
          createdAt: p.createdAt,
        })),
      },
    },
  });
  const mask = `TT-${String(t.id).padStart(6, '0')}`;
  await prisma.ticket.update({ where: { id: t.id }, data: { mask } });
  return { id: t.id, mask };
}

async function main() {
  console.log('Seeding 23T demo client↔supplier ticket pairs…');

  // Wipe prior demo pairs (idempotent re-run). Links/posts cascade on delete.
  const prior = await prisma.ticket.findMany({
    where: { customFields: { path: ['demoPair'], equals: true } },
    select: { id: true },
  });
  if (prior.length) {
    await prisma.ticket.deleteMany({ where: { id: { in: prior.map((t) => t.id) } } });
    console.log(`  Removed ${prior.length} prior demo tickets.`);
  }

  // Reference data.
  const dept = await prisma.department.findFirst({ where: { isDefault: true } });
  const departmentId = dept?.id ?? 1;
  const agent = await prisma.staff.findFirst({ where: { isEnabled: true }, orderBy: { id: 'asc' } });
  if (!agent) throw new Error('No staff found — run `npm run seed` first.');
  const normal = await prisma.ticketPriority.findFirst({ where: { title: 'Normal' } });
  const priorityId = normal?.id ?? 1;

  const customerType = await ensureType('Customer Issue');
  const vendorType = await ensureType('Vendor Issue');

  // Orgs + requester users.
  const carriers = await Promise.all(
    CARRIERS.map(async (c) => ({
      ...c,
      userId: await ensureUser(c.email, c.name, await ensureOrg(c.org, 'SUPPLIER')),
    })),
  );
  const customers = await Promise.all(
    CUSTOMERS.map(async (c) => ({
      ...c,
      userId: await ensureUser(c.email, c.name, await ensureOrg(c.org, 'CLIENT')),
    })),
  );

  const agentName = `${agent.firstName} ${agent.lastName}`.trim() || agent.email;
  let totalClient = 0;
  let totalSupplier = 0;

  for (const sd of STATUS_DEFS) {
    const statusId = await ensureStatus(sd.title, sd.markAsResolved);
    const n = randInt(5, 15);
    for (let i = 0; i < n; i++) {
      const cust = rand(customers);
      const carrier = rand(carriers);
      const dest = rand(DESTINATIONS);
      const base = new Date(Date.now() - randInt(1, 60) * 24 * 3600 * 1000);
      const t1 = new Date(base.getTime() + 3600 * 1000);
      const t2 = new Date(base.getTime() + 2 * 3600 * 1000);
      const t3 = new Date(base.getTime() + 5 * 3600 * 1000);

      // ── Client ticket: customer ↔ 23T only ──
      const clientPosts: PostInput[] = [
        {
          authorType: 'USER',
          userId: cust.userId,
          fullName: cust.name,
          email: cust.email,
          contents: `Our SMS to ${dest} are failing / delayed since this morning. Sender ID "INFO". Can you check the route?`,
          createdAt: base,
        },
      ];
      // Past "Initial", 23T has acknowledged the customer.
      if (sd.title !== 'Initial') {
        clientPosts.push({
          authorType: 'STAFF',
          staffId: agent.id,
          fullName: agentName,
          email: agent.email,
          contents: `Thanks — we are investigating the ${dest} route with our carrier and will update you shortly.`,
          createdAt: t1,
        });
      }
      // Resolved/Closed: 23T confirms the fix to the customer.
      if (sd.markAsResolved) {
        clientPosts.push({
          authorType: 'STAFF',
          staffId: agent.id,
          fullName: agentName,
          email: agent.email,
          contents: `The carrier corrected the ${dest} route. Please retest and confirm delivery on your side.`,
          createdAt: t3,
        });
      }
      const client = await createTicket({
        subject: `SMS delivery issue to ${dest} — Sender ID INFO`,
        departmentId,
        statusId,
        priorityId,
        typeId: customerType,
        requesterEmail: cust.email,
        requesterName: cust.name,
        userId: cust.userId,
        ownerStaffId: agent.id,
        createdAt: base,
        posts: clientPosts,
      });
      totalClient++;

      // ── Supplier ticket: 23T ↔ vendor (isThirdParty) ──
      const supPosts: PostInput[] = [
        {
          authorType: 'STAFF',
          staffId: agent.id,
          fullName: agentName,
          email: agent.email,
          contents: `Hi ${carrier.name}, we see failures/delays on your ${dest} route for Sender ID "INFO". Please investigate.`,
          createdAt: t1,
        },
      ];
      // Once we're past "Pending Vendor", the vendor has replied.
      if (['Reply Received', 'Resolved', 'Closed'].includes(sd.title)) {
        supPosts.push({
          authorType: 'USER',
          userId: carrier.userId,
          fullName: carrier.name,
          email: carrier.email,
          isThirdParty: true,
          contents: `We identified a filtering issue on the ${dest} route and have adjusted it. Please retest.`,
          createdAt: t2,
        });
      }
      const supplier = await createTicket({
        subject: `[Supplier] ${dest} route failure — Sender ID INFO`,
        departmentId,
        statusId,
        priorityId,
        typeId: vendorType,
        requesterEmail: carrier.email,
        requesterName: carrier.name,
        userId: carrier.userId,
        ownerStaffId: agent.id,
        createdAt: t1,
        posts: supPosts,
      });
      totalSupplier++;

      await prisma.ticketLink.create({
        data: { sourceId: client.id, targetId: supplier.id, linkType: 'supplier' },
      });
    }
    console.log(`  ${sd.title}: ${n} client tickets (+ ${n} linked supplier tickets)`);
  }

  console.log(`\n✅ Done: ${totalClient} client tickets, ${totalSupplier} linked supplier tickets.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
