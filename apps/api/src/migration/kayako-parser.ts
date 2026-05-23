/**
 * Pure helpers for the Kayako importer: a MySQL-INSERT parser, dateline→Date
 * conversion, org classification, and the oldId→newId map. Kept under src/ so
 * the build type-checks them and vitest can cover them; the DB-touching runner
 * lives in scripts/import-kayako.ts and imports from here.
 */
import type { OrgType } from '@prisma/client';

export interface ParsedTable {
  columns: string[];
  rows: Array<Record<string, string | null>>;
}

/** Split one VALUES body "(...),(...)" into raw tuple strings (quote/escape aware). */
function splitTuples(body: string): string[] {
  const tuples: string[] = [];
  let depth = 0;
  let cur = '';
  let inQuote = false;
  let esc = false;
  for (const ch of body) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      cur += ch;
      esc = true;
      continue;
    }
    if (ch === "'") {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote && ch === '(') {
      depth++;
      if (depth === 1) continue; // drop the outer paren
    }
    if (!inQuote && ch === ')') {
      depth--;
      if (depth === 0) {
        tuples.push(cur);
        cur = '';
        continue;
      }
    }
    if (depth >= 1) cur += ch;
  }
  return tuples;
}

/** Split one tuple "1,'a','b\\'c',NULL" into typed string|null values. */
function splitValues(tuple: string): Array<string | null> {
  const vals: Array<string | null> = [];
  let cur = '';
  let inQuote = false;
  let esc = false;
  let quoted = false;
  for (const ch of tuple) {
    if (esc) {
      cur += ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch;
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === "'") {
      inQuote = !inQuote;
      quoted = true;
      continue;
    }
    if (ch === ',' && !inQuote) {
      vals.push(quoted ? cur : cur.trim() === 'NULL' ? null : cur.trim());
      cur = '';
      quoted = false;
      continue;
    }
    cur += ch;
  }
  vals.push(quoted ? cur : cur.trim() === 'NULL' ? null : cur.trim());
  return vals;
}

/** Parse all INSERT rows for a given Kayako table from the dump text. */
export function parseTable(sql: string, table: string): ParsedTable {
  const out: ParsedTable = { columns: [], rows: [] };
  // A table may be split across several INSERT statements.
  const re = new RegExp(
    'INSERT INTO `' + table + '`\\s*(?:\\(([^)]*)\\))?\\s*VALUES\\s*(.*?);\\s*(?:\\n|$)',
    'gis',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1] && out.columns.length === 0) {
      out.columns = m[1].split(',').map((c) => c.trim().replace(/`/g, ''));
    }
    for (const tup of splitTuples(m[2]!)) {
      const vals = splitValues(tup);
      const row: Record<string, string | null> = {};
      out.columns.forEach((col, i) => (row[col] = vals[i] ?? null));
      out.rows.push(row);
    }
  }
  return out;
}

/** Kayako stores timestamps as unix seconds; 0 means "unset". */
export function datelineToDate(v: string | null): Date {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** oldKayakoId → newDbId map per table, for FK resolution across the import. */
export class IdMap {
  private maps = new Map<string, Map<number, number>>();
  set(table: string, oldId: number, newId: number) {
    if (!this.maps.has(table)) this.maps.set(table, new Map());
    this.maps.get(table)!.set(oldId, newId);
  }
  get(table: string, oldId: number | null | undefined): number | undefined {
    if (oldId == null) return undefined;
    return this.maps.get(table)?.get(oldId);
  }
}

/**
 * Group swuseremails rows by their owning userId, keeping only user-linked rows
 * (linktype=1; linktype=2 are organization emails). If no row is flagged primary
 * for a user, the first becomes primary (sampled rows are all isprimary=0).
 */
export function groupUserEmails(
  rows: Array<Record<string, string | null>>,
): Map<number, Array<{ email: string; isPrimary: boolean }>> {
  const byUser = new Map<number, Array<{ email: string; isPrimary: boolean }>>();
  for (const r of rows) {
    if (r['linktype'] !== '1') continue;
    const uid = Number(r['linktypeid']);
    const email = (r['email'] ?? '').trim().toLowerCase();
    if (!email) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push({ email, isPrimary: r['isprimary'] === '1' });
  }
  for (const list of byUser.values()) {
    if (!list.some((e) => e.isPrimary) && list[0]) list[0].isPrimary = true;
  }
  return byUser;
}

/**
 * Classify a Kayako organization. Kayako has no client/supplier flag — 23T's
 * "to customer"/"to vendor" macro split confirms the model. 23 Telecom itself is
 * INTERNAL; known carriers are SUPPLIER; everyone else is a CLIENT.
 */
const SUPPLIER_NAMES = ['lleida', 'broadnet', 'sinch', 'nrs gateway', 'nrs', 'tele2', 'horisen'];
export function classifyOrg(name: string): OrgType {
  const n = name.trim().toLowerCase();
  if (n === '23 telecom' || n.startsWith('23telecom') || n.includes('23 telecom')) return 'INTERNAL';
  if (SUPPLIER_NAMES.some((s) => n.includes(s))) return 'SUPPLIER';
  return 'CLIENT';
}

/** Map Kayako swemailqueues.fetchtype/type → our EmailQueueType. */
export function mapQueueType(fetchtype: string | null): 'IMAP' | 'POP3' | 'PIPE' {
  const f = (fetchtype ?? '').toLowerCase();
  if (f.includes('pop')) return 'POP3';
  if (f.includes('pipe')) return 'PIPE';
  return 'IMAP';
}

/** Map Kayako parser-criterion `ruleop` codes → our op vocabulary. */
export function mapRuleOp(code: string | null): string {
  switch (Number(code)) {
    case 1:
      return 'eq';
    case 4:
      return 'contains';
    case 5:
      return 'not_contains';
    case 6:
      return 'starts_with';
    case 7:
      return 'ends_with';
    case 8:
      return 'regex';
    default:
      return 'contains';
  }
}
