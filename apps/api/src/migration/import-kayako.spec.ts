/**
 * Tests for the Kayako importer's pure functions (MySQL-INSERT parser, dateline
 * conversion, org classification). Importing the script here also forces tsc to
 * type-check it (scripts/ is outside the build's src/ include).
 */
import { describe, it, expect } from 'vitest';
import { parseTable, datelineToDate, classifyOrg, IdMap } from './kayako-parser';

const ORG_SQL = `
INSERT INTO \`swuserorganizations\` (\`userorganizationid\`,\`organizationname\`,\`organizationtype\`,\`country\`,\`dateline\`) VALUES (1,'23 Telecom',1,'United States',1599137796),(2,'Lleida',1,'Spain',1600776894),(7,'O\\'Brien Ltd',0,'UK',0);
`;

describe('import-kayako parser', () => {
  it('parses columns and multi-row VALUES into keyed rows', () => {
    const t = parseTable(ORG_SQL, 'swuserorganizations');
    expect(t.columns).toEqual([
      'userorganizationid',
      'organizationname',
      'organizationtype',
      'country',
      'dateline',
    ]);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]!['organizationname']).toBe('23 Telecom');
    expect(t.rows[1]!['country']).toBe('Spain');
  });

  it('handles escaped single-quotes inside string values', () => {
    const t = parseTable(ORG_SQL, 'swuserorganizations');
    expect(t.rows[2]!['organizationname']).toBe("O'Brien Ltd");
  });

  it('returns empty for a table not present in the dump', () => {
    const t = parseTable(ORG_SQL, 'swmacroreplies');
    expect(t.rows).toHaveLength(0);
    expect(t.columns).toHaveLength(0);
  });
});

describe('datelineToDate', () => {
  it('converts unix seconds to a Date', () => {
    expect(datelineToDate('1599137796').getTime()).toBe(1599137796 * 1000);
  });
  it('falls back to now for 0/NULL', () => {
    expect(datelineToDate('0').getTime()).toBeGreaterThan(0);
    expect(datelineToDate(null).getTime()).toBeGreaterThan(0);
  });
});

describe('classifyOrg', () => {
  it('marks 23 Telecom INTERNAL, known carriers SUPPLIER, the rest CLIENT', () => {
    expect(classifyOrg('23 Telecom')).toBe('INTERNAL');
    expect(classifyOrg('Lleida')).toBe('SUPPLIER');
    expect(classifyOrg('Broadnet Networks')).toBe('SUPPLIER');
    expect(classifyOrg('Sinch')).toBe('SUPPLIER');
    expect(classifyOrg('Acme Corp')).toBe('CLIENT');
  });
});

describe('IdMap', () => {
  it('stores and resolves old→new ids per table', () => {
    const m = new IdMap();
    m.set('swuserorganizations', 7, 42);
    expect(m.get('swuserorganizations', 7)).toBe(42);
    expect(m.get('swuserorganizations', 99)).toBeUndefined();
    expect(m.get('swuserorganizations', null)).toBeUndefined();
  });
});
