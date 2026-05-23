/**
 * Seed the 6 P0 + 4 P1 canonical reports (R-01..R-10).
 * Run as part of the main seed or standalone via: tsx src/seed/report-seeds.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const P0_REPORTS = [
  {
    id: 'R-01',
    title: 'R-01: Tickets by Status (Open)',
    kind: 'SUMMARY' as const,
    definition: {
      source: 'tickets',
      filters: [{ field: 'isResolved', op: 'eq', value: false }],
      groupBy: ['statusId'],
      aggregates: [{ func: 'count' }],
      limit: 100,
    },
  },
  {
    id: 'R-02',
    title: 'R-02: Tickets Created Over Time (This Month, by Day)',
    kind: 'TABULAR' as const,
    definition: {
      source: 'tickets',
      filters: [{ field: 'createdAt', op: 'gte', value: 'thisMonth' }],
      groupBy: ['createdAt:day'],
      aggregates: [{ func: 'count' }],
      orderBy: [{ field: 'createdAt:day', dir: 'asc' }],
      limit: 100,
    },
  },
  {
    id: 'R-03',
    title: 'R-03: Open Tickets by Department',
    kind: 'SUMMARY' as const,
    definition: {
      source: 'tickets',
      filters: [{ field: 'isResolved', op: 'eq', value: false }],
      groupBy: ['departmentId'],
      aggregates: [{ func: 'count' }],
      limit: 100,
    },
  },
  {
    id: 'R-04',
    title: 'R-04: Staff Workload (Ticket Count by Owner)',
    kind: 'TABULAR' as const,
    definition: {
      source: 'tickets',
      filters: [{ field: 'isResolved', op: 'eq', value: false }],
      groupBy: ['ownerStaffId'],
      aggregates: [{ func: 'count' }],
      orderBy: [{ field: 'count', dir: 'desc' }],
      limit: 100,
    },
  },
  {
    id: 'R-05',
    title: 'R-05: Avg First Response Time by Department',
    kind: 'TABULAR' as const,
    definition: {
      source: 'tickets',
      filters: [{ field: 'firstResponseAt', op: 'gte', value: 'thisMonth' }],
      groupBy: ['departmentId'],
      aggregates: [{ func: 'avg', field: 'firstResponseSeconds', alias: 'avgFirstResponseSeconds' }],
      limit: 100,
    },
  },
  {
    id: 'R-06',
    title: 'R-06: SLA Breach by Priority',
    kind: 'SUMMARY' as const,
    definition: {
      source: 'tickets',
      filters: [
        { field: 'isResolved', op: 'eq', value: false },
        { field: 'isEscalated', op: 'eq', value: true },
      ],
      groupBy: ['priorityId'],
      aggregates: [{ func: 'count' }],
      limit: 100,
    },
  },
] as const;

const P1_REPORTS = [
  {
    id: 'R-07',
    title: 'R-07: Resolved Tickets by Week (Last Quarter)',
    kind: 'TABULAR' as const,
    definition: {
      source: 'tickets',
      filters: [
        { field: 'isResolved', op: 'eq', value: true },
        { field: 'resolvedAt', op: 'gte', value: 'lastQuarter' },
      ],
      groupBy: ['resolvedAt:week'],
      aggregates: [{ func: 'count' }],
      orderBy: [{ field: 'resolvedAt:week', dir: 'asc' }],
      limit: 100,
    },
  },
  {
    id: 'R-08',
    title: 'R-08: Avg Resolution Time by Priority',
    kind: 'TABULAR' as const,
    definition: {
      source: 'tickets',
      filters: [{ field: 'isResolved', op: 'eq', value: true }],
      groupBy: ['priorityId'],
      aggregates: [{ func: 'avg', field: 'resolutionSeconds', alias: 'avgResolutionSeconds' }],
      limit: 100,
    },
  },
  {
    id: 'R-09',
    title: 'R-09: Staff Activity (Audit Logs by Staff + Action)',
    kind: 'TABULAR' as const,
    definition: {
      source: 'ticketAuditLogs',
      filters: [{ field: 'actorType', op: 'eq', value: 'STAFF' }],
      groupBy: ['staffId', 'action'],
      aggregates: [{ func: 'count' }],
      orderBy: [{ field: 'count', dir: 'desc' }],
      limit: 200,
    },
  },
  {
    id: 'R-10',
    title: 'R-10: Tickets by Creation Mode (This Year)',
    kind: 'SUMMARY' as const,
    definition: {
      source: 'tickets',
      filters: [{ field: 'createdAt', op: 'gte', value: 'thisYear' }],
      groupBy: ['creationMode'],
      aggregates: [{ func: 'count' }],
      limit: 100,
    },
  },
] as const;

export async function seedReports(client: PrismaClient = prisma): Promise<void> {
  const allReports = [...P0_REPORTS, ...P1_REPORTS];

  for (const r of allReports) {
    const existing = await client.report.findFirst({ where: { title: r.title } });
    if (!existing) {
      await client.report.create({
        data: {
          title: r.title,
          kind: r.kind,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          definition: r.definition as any,
        },
      });
      console.log(`  Created report: ${r.id} — ${r.title}`);
    } else {
      // Update definition to keep in sync
      await client.report.update({
        where: { id: existing.id },
        data: {
          kind: r.kind,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          definition: r.definition as any,
        },
      });
      console.log(`  Updated report: ${r.id} — ${r.title}`);
    }
  }
}

// Run standalone
if (require.main === module) {
  seedReports()
    .catch((err: unknown) => {
      console.error('Report seed error:', err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
