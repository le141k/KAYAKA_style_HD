import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import type { TicketsService } from './tickets.service';

// D7 — the @Public() portal endpoints must never echo the raw Ticket / TicketPost
// to an unauthenticated caller. Those models carry ipAddress, creationMode,
// staffId, slaPlanId, internal SLA timestamps and (encrypted) customFields.
describe('TicketsController public projections (D7)', () => {
  const turnstile = { verify: async () => undefined };
  const abuseQuota = { consume: async () => undefined };
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
    const service = {
      resolvePublicDepartmentId: async () => 1,
      createTicket: async () => rawTicket,
    } as unknown as TicketsService;
    const controller = new TicketsController(service, turnstile as never, abuseQuota as never);

    const out = await controller.publicCreate(
      {
        subject: 'Hi',
        contents: 'body',
        requesterEmail: 'a@b.com',
        requesterName: 'A',
        customFields: {},
      } as never,
      '203.0.113.1',
    );

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
    const controller = new TicketsController(service, turnstile as never, abuseQuota as never);

    const out = await controller.publicReply(
      7,
      { contents: 'reply' } as never,
      {
        userId: 1,
      } as never,
    );

    expect(out).toEqual({
      id: 42,
      ticketId: 7,
      contents: 'reply',
      isHtml: false,
      createdAt: rawPost.createdAt,
    });
    for (const key of SENSITIVE) expect(key in out).toBe(false);
  });

  it('never creates an anonymous ticket in a missing/private department', async () => {
    const createTicket = vi.fn();
    const service = {
      resolvePublicDepartmentId: vi
        .fn()
        .mockRejectedValue(new BadRequestException('Public department is unavailable')),
      createTicket,
    } as unknown as TicketsService;
    const controller = new TicketsController(service, turnstile as never, abuseQuota as never);

    await expect(
      controller.publicCreate(
        {
          subject: 'Hi',
          contents: 'body',
          requesterEmail: 'a@b.com',
          requesterName: 'A',
          departmentId: 999,
          customFields: {},
        } as never,
        '203.0.113.1',
      ),
    ).rejects.toThrow('Public department is unavailable');
    expect(createTicket).not.toHaveBeenCalled();
  });
});
