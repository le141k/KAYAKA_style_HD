/**
 * Report compiler: translates a validated ReportDefinition into Prisma calls
 * and returns an array of plain row objects.
 *
 * Security guarantee: every field name is checked against FILTERABLE_FIELDS /
 * GROUPABLE_FIELDS whitelists before being passed to Prisma — no raw SQL ever.
 */
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ReportDefinition,
  ReportFilter,
  FILTERABLE_FIELDS,
  GROUPABLE_FIELDS,
  NUMERIC_FIELDS,
  COMPUTED_FIELDS,
} from './report-definition.schema';
import { resolveDate, bucketDate } from './reports.utils';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReportRow = Record<string, unknown>;

/**
 * Hard cap on rows pulled into memory for the in-JS "slow path" aggregation.
 * Prevents an unbounded `findMany` from OOM-ing the API process on large
 * datasets; if a report matches more than this, the caller must narrow the
 * filter / date range rather than silently aggregating a partial set.
 */
const SLOW_PATH_SCAN_CAP = 50_000;

/** Throws if a slow-path scan would exceed the cap (records fetched with cap+1). */
function assertWithinScanCap(records: unknown[]): void {
  if (records.length > SLOW_PATH_SCAN_CAP) {
    throw new BadRequestException(
      `Report matches more than ${SLOW_PATH_SCAN_CAP.toLocaleString()} rows; narrow the filters or date range.`,
    );
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Prisma `where` object from a list of filters.
 * Throws BadRequestException if any field is not in the whitelist.
 */
export function buildWhere(
  filters: ReportFilter[],
  source: ReportDefinition['source'],
): Record<string, unknown> {
  const allowed = FILTERABLE_FIELDS[source];
  const where: Record<string, unknown> = {};

  for (const f of filters) {
    if (!allowed.includes(f.field)) {
      throw new BadRequestException(`Filter field "${f.field}" is not allowed for source "${source}"`);
    }
    switch (f.op) {
      case 'eq':
        where[f.field] = f.value;
        break;
      case 'neq':
        where[f.field] = { not: f.value };
        break;
      case 'in':
        where[f.field] = { in: f.value };
        break;
      case 'notIn':
        where[f.field] = { notIn: f.value };
        break;
      case 'lt':
        where[f.field] = { lt: resolveDateValue(f.value) };
        break;
      case 'lte':
        where[f.field] = { lte: resolveDateValue(f.value) };
        break;
      case 'gt':
        where[f.field] = { gt: resolveDateValue(f.value) };
        break;
      case 'gte':
        where[f.field] = { gte: resolveDateValue(f.value) };
        break;
      case 'between': {
        const range = resolveBetween(f.from, f.to);
        where[f.field] = range;
        break;
      }
    }
  }

  return where;
}

function resolveDateValue(value: string): Date {
  // Try relative tokens first
  try {
    const range = resolveDate(value);
    return range.gte; // for lt/lte/gt/gte, use the start of the range
  } catch {
    // Absolute ISO string
    return new Date(value);
  }
}

function resolveBetween(from: string, to: string): { gte: Date; lt: Date } {
  const resolveOne = (v: string): Date => {
    try {
      return resolveDate(v).gte;
    } catch {
      return new Date(v);
    }
  };
  return { gte: resolveOne(from), lt: resolveOne(to) };
}

// ─── Compiler ─────────────────────────────────────────────────────────────────

@Injectable()
export class ReportCompiler {
  constructor(private readonly prisma: PrismaService) {}

  async compile(def: ReportDefinition): Promise<ReportRow[]> {
    switch (def.source) {
      case 'tickets':
        return this.compileTickets(def);
      case 'ticketPosts':
        return this.compileTicketPosts(def);
      case 'ticketAuditLogs':
        return this.compileTicketAuditLogs(def);
      default: {
        const _: never = def.source;
        throw new BadRequestException(`Unknown source: ${String(_)}`);
      }
    }
  }

  // ─── tickets ──────────────────────────────────────────────────────────────

  private async compileTickets(def: ReportDefinition): Promise<ReportRow[]> {
    // Validate groupBy fields
    const allowedGroup = GROUPABLE_FIELDS['tickets'];
    for (const g of def.groupBy) {
      if (!allowedGroup.includes(g)) {
        throw new BadRequestException(`groupBy field "${g}" is not allowed for source "tickets"`);
      }
    }

    const where = buildWhere(def.filters, 'tickets');

    const hasBucketGroup = def.groupBy.some((g) => g.includes(':'));
    const hasComputedAgg = def.aggregates.some((a) => a.field && COMPUTED_FIELDS.includes(a.field));
    const hasNonCountAgg = def.aggregates.some(
      (a) => a.func !== 'count' && a.field && !COMPUTED_FIELDS.includes(a.field),
    );

    if (!hasBucketGroup && !hasComputedAgg && !hasNonCountAgg) {
      // Fast path: prisma.groupBy
      return this.ticketsFastPath(def, where);
    }

    // Slow path: findMany + JS aggregation
    return this.ticketsSlowPath(def, where);
  }

  private async ticketsFastPath(def: ReportDefinition, where: Record<string, unknown>): Promise<ReportRow[]> {
    const pureGroupBy = def.groupBy as string[];

    if (pureGroupBy.length === 0) {
      // Simple count
      const count = await this.prisma.ticket.count({ where });
      return [{ count }];
    }

    const rows = await this.prisma.ticket.groupBy({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      by: pureGroupBy as any,
      where,
      _count: { _all: true },
    });

    return rows.slice(0, def.limit).map((r) => {
      const row: ReportRow = {};
      for (const g of pureGroupBy) {
        row[g] = (r as Record<string, unknown>)[g];
      }
      row['count'] = r._count._all;
      return row;
    });
  }

  private async ticketsSlowPath(def: ReportDefinition, where: Record<string, unknown>): Promise<ReportRow[]> {
    // Build select: we need all groupBy base fields + numeric aggregate fields
    const selectFields: Record<string, boolean> = {
      id: true,
      createdAt: true,
    };

    for (const g of def.groupBy) {
      const baseField = g.split(':')[0] ?? g;
      selectFields[baseField] = true;
    }

    for (const agg of def.aggregates) {
      if (agg.func !== 'count' && agg.field) {
        if (!COMPUTED_FIELDS.includes(agg.field)) {
          selectFields[agg.field] = true;
        } else {
          // firstResponseSeconds needs firstResponseAt, resolutionSeconds needs resolvedAt
          if (agg.field === 'firstResponseSeconds') {
            selectFields['firstResponseAt'] = true;
            selectFields['createdAt'] = true;
          } else if (agg.field === 'resolutionSeconds') {
            selectFields['resolvedAt'] = true;
            selectFields['createdAt'] = true;
          }
        }
      }
    }

    const records = await this.prisma.ticket.findMany({
      where,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: selectFields as any,
      take: SLOW_PATH_SCAN_CAP + 1,
    });
    assertWithinScanCap(records);

    return this.groupAndAggregate(records as Record<string, unknown>[], def);
  }

  // ─── ticketPosts ──────────────────────────────────────────────────────────

  private async compileTicketPosts(def: ReportDefinition): Promise<ReportRow[]> {
    const allowedGroup = GROUPABLE_FIELDS['ticketPosts'];
    for (const g of def.groupBy) {
      if (!allowedGroup.includes(g)) {
        throw new BadRequestException(`groupBy field "${g}" is not allowed for source "ticketPosts"`);
      }
    }

    const where = buildWhere(def.filters, 'ticketPosts');
    const hasBucketGroup = def.groupBy.some((g) => g.includes(':'));

    if (!hasBucketGroup && def.aggregates.every((a) => a.func === 'count')) {
      // Fast path
      if (def.groupBy.length === 0) {
        const count = await this.prisma.ticketPost.count({ where });
        return [{ count }];
      }
      const rows = await this.prisma.ticketPost.groupBy({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        by: def.groupBy as any,
        where,
        _count: { _all: true },
      });
      return rows.slice(0, def.limit).map((r) => {
        const row: ReportRow = {};
        for (const g of def.groupBy) row[g] = (r as Record<string, unknown>)[g];
        row['count'] = r._count._all;
        return row;
      });
    }

    // Slow path
    const selectFields: Record<string, boolean> = { id: true, createdAt: true };
    for (const g of def.groupBy) selectFields[g.split(':')[0] ?? g] = true;

    const records = await this.prisma.ticketPost.findMany({
      where,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: selectFields as any,
      take: SLOW_PATH_SCAN_CAP + 1,
    });
    assertWithinScanCap(records);
    return this.groupAndAggregate(records as Record<string, unknown>[], def);
  }

  // ─── ticketAuditLogs ──────────────────────────────────────────────────────

  private async compileTicketAuditLogs(def: ReportDefinition): Promise<ReportRow[]> {
    const allowedGroup = GROUPABLE_FIELDS['ticketAuditLogs'];
    for (const g of def.groupBy) {
      if (!allowedGroup.includes(g)) {
        throw new BadRequestException(`groupBy field "${g}" is not allowed for source "ticketAuditLogs"`);
      }
    }

    const where = buildWhere(def.filters, 'ticketAuditLogs');
    const hasBucketGroup = def.groupBy.some((g) => g.includes(':'));

    if (!hasBucketGroup && def.aggregates.every((a) => a.func === 'count')) {
      if (def.groupBy.length === 0) {
        const count = await this.prisma.ticketAuditLog.count({ where });
        return [{ count }];
      }
      const rows = await this.prisma.ticketAuditLog.groupBy({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        by: def.groupBy as any,
        where,
        _count: { _all: true },
      });
      return rows.slice(0, def.limit).map((r) => {
        const row: ReportRow = {};
        for (const g of def.groupBy) row[g] = (r as Record<string, unknown>)[g];
        row['count'] = r._count._all;
        return row;
      });
    }

    // Slow path
    const selectFields: Record<string, boolean> = { id: true, createdAt: true };
    for (const g of def.groupBy) selectFields[g.split(':')[0] ?? g] = true;

    const records = await this.prisma.ticketAuditLog.findMany({
      where,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      select: selectFields as any,
      take: SLOW_PATH_SCAN_CAP + 1,
    });
    assertWithinScanCap(records);
    return this.groupAndAggregate(records as Record<string, unknown>[], def);
  }

  // ─── JS grouping + aggregation ────────────────────────────────────────────

  private groupAndAggregate(records: Record<string, unknown>[], def: ReportDefinition): ReportRow[] {
    type GroupBucket = { rows: Record<string, unknown>[]; key: Record<string, unknown> };
    const groups = new Map<string, GroupBucket>();

    for (const r of records) {
      const keyParts: Record<string, unknown> = {};
      for (const g of def.groupBy) {
        if (g.includes(':')) {
          const colonIdx = g.indexOf(':');
          const field = g.slice(0, colonIdx);
          const bucket = g.slice(colonIdx + 1) as 'day' | 'week' | 'month';
          keyParts[g] = bucketDate(r[field] as Date | null | undefined, bucket);
        } else {
          keyParts[g] = r[g];
        }
      }
      const keyStr = JSON.stringify(keyParts);
      if (!groups.has(keyStr)) {
        groups.set(keyStr, { rows: [], key: keyParts });
      }
      groups.get(keyStr)!.rows.push(r);
    }

    const result: ReportRow[] = [];
    for (const { rows, key } of groups.values()) {
      const row: ReportRow = { ...key };
      for (const agg of def.aggregates) {
        const alias = agg.alias ?? (agg.field ? `${agg.func}_${agg.field}` : agg.func);
        if (agg.func === 'count') {
          row[alias] = rows.length;
        } else if (agg.field) {
          const values = rows
            .map((r) => this.getNumericValue(r, agg.field!))
            .filter((v): v is number => v !== null);
          row[alias] = computeAggregate(agg.func, values);
        }
      }
      result.push(row);
    }

    // Apply orderBy
    if (def.orderBy && def.orderBy.length > 0) {
      result.sort((a, b) => {
        for (const { field, dir } of def.orderBy!) {
          const av = a[field] ?? '';
          const bv = b[field] ?? '';
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          if (cmp !== 0) return dir === 'asc' ? cmp : -cmp;
        }
        return 0;
      });
    }

    return result.slice(0, def.limit);
  }

  private getNumericValue(r: Record<string, unknown>, field: string | undefined): number | null {
    if (!field) return null;
    if (field === 'firstResponseSeconds') {
      const createdAt = r['createdAt'] as Date | undefined;
      const firstResponseAt = r['firstResponseAt'] as Date | undefined;
      if (!createdAt || !firstResponseAt) return null;
      return (new Date(firstResponseAt).getTime() - new Date(createdAt).getTime()) / 1000;
    }
    if (field === 'resolutionSeconds') {
      const createdAt = r['createdAt'] as Date | undefined;
      const resolvedAt = r['resolvedAt'] as Date | undefined;
      if (!createdAt || !resolvedAt) return null;
      return (new Date(resolvedAt).getTime() - new Date(createdAt).getTime()) / 1000;
    }
    // Direct numeric field
    if (!NUMERIC_FIELDS.includes(field)) return null;
    const v = r[field];
    if (typeof v === 'number') return v;
    return null;
  }
}

function computeAggregate(func: 'avg' | 'sum' | 'min' | 'max', values: number[]): number | null {
  if (values.length === 0) return null;
  switch (func) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}
