/**
 * Utility functions for the reports engine.
 */
import type { RelativeDateToken } from './report-definition.schema';

export interface DateRange {
  gte: Date;
  lt: Date;
}

/**
 * Resolve a relative date token to an absolute { gte, lt } range (UTC).
 */
export function resolveDate(token: string): DateRange {
  const now = new Date();
  // Midnight today UTC
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  switch (token as RelativeDateToken) {
    case 'today':
      return { gte: todayStart, lt: addDays(todayStart, 1) };
    case 'yesterday':
      return { gte: addDays(todayStart, -1), lt: todayStart };
    case 'thisWeek': {
      // Monday of current week
      const dow = todayStart.getUTCDay(); // 0=Sun
      const diff = dow === 0 ? -6 : 1 - dow;
      const weekStart = addDays(todayStart, diff);
      return { gte: weekStart, lt: addDays(weekStart, 7) };
    }
    case 'lastWeek': {
      const dow = todayStart.getUTCDay();
      const diff = dow === 0 ? -6 : 1 - dow;
      const thisWeekStart = addDays(todayStart, diff);
      const lastWeekStart = addDays(thisWeekStart, -7);
      return { gte: lastWeekStart, lt: thisWeekStart };
    }
    case 'thisMonth': {
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return { gte: monthStart, lt: nextMonthStart };
    }
    case 'lastMonth': {
      const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { gte: lastMonthStart, lt: thisMonthStart };
    }
    case 'last7days':
      return { gte: addDays(todayStart, -7), lt: addDays(todayStart, 1) };
    case 'last30days':
      return { gte: addDays(todayStart, -30), lt: addDays(todayStart, 1) };
    case 'last90days':
      return { gte: addDays(todayStart, -90), lt: addDays(todayStart, 1) };
    case 'thisYear': {
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const nextYearStart = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      return { gte: yearStart, lt: nextYearStart };
    }
    case 'lastQuarter': {
      const q = Math.floor(now.getUTCMonth() / 3);
      const qStart = new Date(Date.UTC(now.getUTCFullYear(), (q - 1) * 3, 1));
      const qEnd = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
      // Handle q=0 (previous year Q4)
      if (q === 0) {
        return {
          gte: new Date(Date.UTC(now.getUTCFullYear() - 1, 9, 1)),
          lt: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
        };
      }
      return { gte: qStart, lt: qEnd };
    }
    default:
      // Treat as ISO date string
      throw new Error(`Unknown relative date token: ${token}`);
  }
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * Bucket a Date into a string key by granularity (day/week/month).
 */
export function bucketDate(date: Date | null | undefined, bucket: 'day' | 'week' | 'month'): string {
  if (!date) return 'null';
  const d = new Date(date);
  if (bucket === 'day') {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  if (bucket === 'month') {
    return d.toISOString().slice(0, 7); // YYYY-MM
  }
  // week: ISO week key YYYY-Www
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Convert an array of plain objects to a CSV string.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))];
  return lines.join('\n');
}
