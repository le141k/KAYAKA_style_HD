/**
 * Tests for the Kayako importer's pure functions (MySQL-INSERT parser, dateline
 * conversion, org classification). Importing the script here also forces tsc to
 * type-check it (scripts/ is outside the build's src/ include).
 */
import { describe, it, expect } from 'vitest';
import {
  parseTable,
  datelineToDate,
  classifyOrg,
  groupUserEmails,
  mapQueueType,
  mapRuleOp,
  IdMap,
} from './kayako-parser';

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

describe('groupUserEmails', () => {
  it('keeps only user-linked emails (linktype=1), skips org emails (linktype=2)', () => {
    const m = groupUserEmails([
      { linktype: '1', linktypeid: '1', email: 'A@X.com', isprimary: '0' },
      { linktype: '2', linktypeid: '1', email: 'org@x.com', isprimary: '0' },
      { linktype: '1', linktypeid: '2', email: 'b@x.com', isprimary: '1' },
    ]);
    expect([...m.keys()].sort()).toEqual([1, 2]);
    expect(m.get(1)).toEqual([{ email: 'a@x.com', isPrimary: true }]); // lowercased + first→primary
    expect(m.get(2)).toEqual([{ email: 'b@x.com', isPrimary: true }]);
  });

  it('defaults the first email to primary only when none is flagged', () => {
    const m = groupUserEmails([
      { linktype: '1', linktypeid: '5', email: 'one@x.com', isprimary: '0' },
      { linktype: '1', linktypeid: '5', email: 'two@x.com', isprimary: '0' },
    ]);
    expect(m.get(5)).toEqual([
      { email: 'one@x.com', isPrimary: true },
      { email: 'two@x.com', isPrimary: false },
    ]);
  });
});

describe('mapQueueType', () => {
  it('maps fetchtype to our queue type', () => {
    expect(mapQueueType('imapssl')).toBe('IMAP');
    expect(mapQueueType('pop3')).toBe('POP3');
    expect(mapQueueType('pipe')).toBe('PIPE');
    expect(mapQueueType(null)).toBe('IMAP');
  });
});

describe('mapRuleOp', () => {
  it('maps Kayako ruleop codes to our ops (4=contains for bounce rules)', () => {
    expect(mapRuleOp('1')).toBe('eq');
    expect(mapRuleOp('4')).toBe('contains');
    expect(mapRuleOp('8')).toBe('regex');
    expect(mapRuleOp('99')).toBe('contains'); // unknown → safe default
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
