import { describe, it, expect } from 'vitest';
import { ReportDefinitionSchema } from './report-definition.schema';

describe('ReportDefinitionSchema', () => {
  // ─── Valid cases ───────────────────────────────────────────────────────────

  it('accepts a minimal valid definition', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe('tickets');
      expect(result.data.limit).toBe(100);
    }
  });

  it('accepts count aggregate without field', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      aggregates: [{ func: 'count' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts avg aggregate with a valid numeric field', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      aggregates: [{ func: 'avg', field: 'firstResponseSeconds' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts groupBy with date bucket notation', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      groupBy: ['createdAt:day'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts up to 3 groupBy fields', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      groupBy: ['statusId', 'priorityId', 'departmentId'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts ticketAuditLogs source', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'ticketAuditLogs',
      filters: [{ field: 'actorType', op: 'eq', value: 'STAFF' }],
      groupBy: ['staffId', 'action'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts ticketPosts source', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'ticketPosts',
      groupBy: ['authorType'],
    });
    expect(result.success).toBe(true);
  });

  // ─── Rejection: unknown source ─────────────────────────────────────────────

  it('rejects unknown source', () => {
    const result = ReportDefinitionSchema.safeParse({ source: 'unknownTable' });
    expect(result.success).toBe(false);
  });

  // ─── Rejection: >3 groupBy ─────────────────────────────────────────────────

  it('rejects groupBy with more than 3 fields', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      groupBy: ['statusId', 'priorityId', 'departmentId', 'typeId'],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      expect(JSON.stringify(flat)).toContain('groupBy');
    }
  });

  // ─── Rejection: avg without field ─────────────────────────────────────────

  it('rejects avg aggregate without a field', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      aggregates: [{ func: 'avg' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects sum aggregate without a field', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      aggregates: [{ func: 'sum' }],
    });
    expect(result.success).toBe(false);
  });

  // ─── Rejection: non-whitelisted filter field ───────────────────────────────

  it('rejects filter field not in whitelist', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      filters: [{ field: 'rawSqlInjection', op: 'eq', value: '1=1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects groupBy field not in whitelist', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      groupBy: ['DROP TABLE tickets'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects aggregate field not in numeric whitelist', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      aggregates: [{ func: 'avg', field: 'subject' }],
    });
    expect(result.success).toBe(false);
  });

  // ─── Relative date token parsing ───────────────────────────────────────────

  it('accepts relative date token in filter', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      filters: [{ field: 'createdAt', op: 'gte', value: 'thisMonth' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts between with relative tokens', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      filters: [{ field: 'createdAt', op: 'between', from: 'lastMonth', to: 'thisMonth' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts between with absolute ISO dates', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      filters: [
        {
          field: 'createdAt',
          op: 'between',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-02-01T00:00:00.000Z',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts all relative date tokens', () => {
    const tokens = [
      'today',
      'yesterday',
      'thisWeek',
      'lastWeek',
      'thisMonth',
      'lastMonth',
      'last7days',
      'last30days',
      'last90days',
      'thisYear',
      'lastQuarter',
    ];
    for (const token of tokens) {
      const result = ReportDefinitionSchema.safeParse({
        source: 'tickets',
        filters: [{ field: 'createdAt', op: 'gte', value: token }],
      });
      expect(result.success, `token: ${token}`).toBe(true);
    }
  });

  // ─── Limit boundary ────────────────────────────────────────────────────────

  it('accepts limit of exactly 1000', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      limit: 1000,
    });
    expect(result.success).toBe(true);
  });

  it('rejects limit greater than 1000', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      limit: 1001,
    });
    expect(result.success).toBe(false);
  });

  it('rejects limit of 0', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'tickets',
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  // ─── Cross-source field isolation ──────────────────────────────────────────

  it('rejects tickets-only filter field used on ticketPosts', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'ticketPosts',
      filters: [{ field: 'ownerStaffId', op: 'eq', value: 1 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects tickets-only groupBy on ticketAuditLogs', () => {
    const result = ReportDefinitionSchema.safeParse({
      source: 'ticketAuditLogs',
      groupBy: ['departmentId'],
    });
    expect(result.success).toBe(false);
  });
});
