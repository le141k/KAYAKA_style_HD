import { describe, it, expect } from 'vitest';
import { TicketsController } from './tickets.controller';
import type { TicketsService } from './tickets.service';

// D7 — the @Public() portal endpoints must never echo the raw Ticket / TicketPost
// to an unauthenticated caller. Those models carry ipAddress, creationMode,
// staffId, slaPlanId, internal SLA timestamps and (encrypted) customFields.
describe('TicketsController public projections (D7)', () => {
  const SENSITIVE = [
    'ipAddress',
    'creationMode',
    'slaPlanId',
    'staffId',
    'email',
    'customFields',
    'dueAt',
    'resolvedAt',
  ];

  it('publicCreate returns only public-safe fields', async () => {
    const rawTicket = {
      id: 7,
      mask: 'TT-007',
      subject: 'Hi',
      statusId: 1,
      createdAt: new Date(),
      // fields that must NOT leak:
      ipAddress: '6.6.6.6',
      creationMode: 'WEB',
      slaPlanId: 3,
      customFields: { secret: 'x' },
      dueAt: new Date(),
      resolvedAt: null,
    };
    const service = { createTicket: async () => rawTicket } as unknown as TicketsService;
    const controller = new TicketsController(service);

    const out = await controller.publicCreate({
      subject: 'Hi',
      contents: 'body',
      requesterEmail: 'a@b.com',
      requesterName: 'A',
      customFields: {},
    } as never);

    expect(out).toEqual({
      id: 7,
      mask: 'TT-007',
      subject: 'Hi',
      statusId: 1,
      createdAt: rawTicket.createdAt,
    });
    for (const key of SENSITIVE) expect(key in out).toBe(false);
  });

  it('publicReply returns only public-safe fields', async () => {
    const rawPost = {
      id: 42,
      ticketId: 7,
      contents: 'reply',
      isHtml: false,
      createdAt: new Date(),
      // must NOT leak:
      ipAddress: '6.6.6.6',
      creationMode: 'WEB',
      staffId: null,
      email: 'a@b.com',
    };
    const service = { publicReply: async () => rawPost } as unknown as TicketsService;
    const controller = new TicketsController(service);

    const out = await controller.publicReply(7, {
      contents: 'reply',
      requesterEmail: 'a@b.com',
    } as never);

    expect(out).toEqual({
      id: 42,
      ticketId: 7,
      contents: 'reply',
      isHtml: false,
      createdAt: rawPost.createdAt,
    });
    for (const key of SENSITIVE) expect(key in out).toBe(false);
  });
});
