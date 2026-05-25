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
