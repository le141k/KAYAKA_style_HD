import { describe, it, expect } from 'vitest';
import { CreateTicketSchema, ReplyTicketSchema, ListTicketsQuerySchema } from './dto';

// C2 — short search terms (<3 chars) can't use the trigram GIN index → treated as
// "no search filter" instead of seq-scanning.
describe('ticket list search guard (C2)', () => {
  it('ignores a <3-char search term', () => {
    expect(ListTicketsQuerySchema.parse({ search: 'ab' }).search).toBeUndefined();
    expect(ListTicketsQuerySchema.parse({ search: '  x ' }).search).toBeUndefined();
  });
  it('keeps a >=3-char search term (trimmed)', () => {
    expect(ListTicketsQuerySchema.parse({ search: '  router ' }).search).toBe('router');
  });
});

// B1 — mass-assignment guard: the staff-facing schemas must NOT accept
// creationMode / ipAddress from the request body (Zod strips unknown keys),
// so an agent cannot forge an EMAIL/ALARIS ticket or spoof the source IP.
describe('ticket DTO mass-assignment guard (B1)', () => {
  it('CreateTicketSchema strips creationMode and ipAddress', () => {
    const parsed = CreateTicketSchema.parse({
      subject: 'Hello world subject',
      contents: 'some body content here',
      departmentId: 1,
      requesterEmail: 'user@example.com',
      // attacker-injected fields:
      creationMode: 'ALARIS',
      ipAddress: '6.6.6.6',
    });
    expect('creationMode' in parsed).toBe(false);
    expect('ipAddress' in parsed).toBe(false);
  });

  it('ReplyTicketSchema strips creationMode and ipAddress', () => {
    const parsed = ReplyTicketSchema.parse({
      contents: 'a reply',
      creationMode: 'EMAIL',
      ipAddress: '6.6.6.6',
    });
    expect('creationMode' in parsed).toBe(false);
    expect('ipAddress' in parsed).toBe(false);
  });
});

// E1 — input caps: unbounded free-text / arrays are rejected past their cap.
describe('ticket DTO input caps (E1)', () => {
  const base = {
    subject: 'Hello world subject',
    departmentId: 1,
    requesterEmail: 'user@example.com',
  };

  it('rejects a body over the 100k cap', () => {
    const huge = 'x'.repeat(100_001);
    expect(CreateTicketSchema.safeParse({ ...base, contents: huge }).success).toBe(false);
    expect(CreateTicketSchema.safeParse({ ...base, contents: 'ok' }).success).toBe(true);
  });

  it('rejects more than 50 tags', () => {
    const tags = Array.from({ length: 51 }, (_, i) => `t${i}`);
    expect(CreateTicketSchema.safeParse({ ...base, contents: 'ok', tags }).success).toBe(false);
  });

  it('rejects an over-long reply body', () => {
    expect(ReplyTicketSchema.safeParse({ contents: 'x'.repeat(100_001) }).success).toBe(false);
  });
});
