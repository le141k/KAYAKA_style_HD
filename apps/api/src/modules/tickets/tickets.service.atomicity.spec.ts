import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ticket, TicketPost } from '@prisma/client';
import { TicketsService } from './tickets.service';

function ticket(overrides: Record<string, unknown> = {}): Ticket {
  return {
    id: 1,
    mask: 'TT-000001',
    subject: 'Atomicity',
    requesterName: 'Requester',
    requesterEmail: '',
    departmentId: 2,
    userId: 9,
    firstResponseAt: null,
    isResolved: false,
    ...overrides,
  } as Ticket;
}

function post(overrides: Record<string, unknown> = {}): TicketPost {
  return {
    id: 10,
    ticketId: 1,
    messageId: '',
    contents: 'body',
    ...overrides,
  } as TicketPost;
}

describe('TicketsService reply/note atomicity and inbound idempotency', () => {
  let tx: Record<string, any>;
  let prisma: Record<string, any>;
  let attachments: Record<string, any>;
  let users: Record<string, any>;
  let emitter: Record<string, any>;
  let mail: Record<string, any>;
  let service: TicketsService;

  beforeEach(() => {
    tx = {
      ticket: { create: vi.fn(), update: vi.fn() },
      ticketPost: { create: vi.fn() },
      ticketNote: { create: vi.fn() },
      attachment: { findMany: vi.fn().mockResolvedValue([]) },
      outboundEmail: { create: vi.fn().mockResolvedValue({ id: 'outbox-1' }) },
      ticketAuditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    prisma = {
      ticket: { findUnique: vi.fn(), update: vi.fn() },
      ticketPost: { findFirst: vi.fn(), create: vi.fn() },
      ticketNote: { create: vi.fn() },
      ticketAuditLog: { create: vi.fn().mockResolvedValue({}) },
      ticketStatus: { findFirst: vi.fn() },
      ticketPriority: { findFirst: vi.fn() },
      ticketRecipient: { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() },
      emailQueue: { findFirst: vi.fn() },
      user: { findUnique: vi.fn().mockResolvedValue({ organizationId: null }) },
      staff: { findUnique: vi.fn().mockResolvedValue(null) },
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    };
    attachments = {
      linkToPost: vi.fn().mockResolvedValue(undefined),
      linkToNote: vi.fn().mockResolvedValue(undefined),
    };
    users = { findOrCreate: vi.fn().mockResolvedValue({ id: 9 }) };
    emitter = { emit: vi.fn() };
    mail = {
      sendTemplate: vi.fn().mockResolvedValue(undefined),
      enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    };
    const sla = {
      resolvePlanForTicket: vi.fn().mockResolvedValue(null),
      computeDueDates: vi.fn(),
    };
    const admin = {
      validateCustomFields: vi.fn().mockResolvedValue(undefined),
      encryptCustomFields: vi.fn().mockImplementation((_scope, value) => Promise.resolve(value)),
    };
    service = new TicketsService(
      prisma as never,
      users as never,
      sla as never,
      emitter as never,
      mail as never,
      admin as never,
      attachments as never,
    );
  });

  it('commits staff post, attachment adoption, counters and audit in one transaction', async () => {
    const existingTicket = ticket({ requesterEmail: 'customer@example.test' });
    const createdPost = post();
    prisma.ticket.findUnique.mockResolvedValue(existingTicket);
    tx.ticketPost.create.mockResolvedValue(createdPost);
    tx.ticket.update.mockResolvedValue(existingTicket);
    tx.attachment.findMany.mockResolvedValue([
      {
        id: 7,
        fileName: 'reply.txt',
        mimeType: 'text/plain',
        size: 12,
        sha1: 'b'.repeat(40),
        storageKey: 'tickets/1/reply.txt',
      },
    ]);

    const result = await service.reply(
      1,
      {
        contents: 'reply',
        isHtml: false,
        isNote: false,
        isEmailed: false,
        isThirdParty: false,
        attachmentIds: [7],
      },
      5,
    );

    expect(result).toBe(createdPost);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(attachments.linkToPost).toHaveBeenCalledWith([7], 10, 1, undefined, tx);
    expect(tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalReplies: { increment: 1 },
          hasAttachments: true,
        }),
      }),
    );
    expect(tx.ticketAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'REPLY' }) }),
    );
    expect(prisma.ticketAuditLog.create).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledWith('ticket.replied', { ticketId: 1 });
  });

  it('does not update counters, audit or emit when attachment adoption fails', async () => {
    prisma.ticket.findUnique.mockResolvedValue(ticket({ requesterEmail: 'customer@example.test' }));
    tx.ticketPost.create.mockResolvedValue(post());
    attachments.linkToPost.mockRejectedValue(new BadRequestException('claim failed'));

    await expect(
      service.reply(
        1,
        {
          contents: 'reply',
          isHtml: false,
          isNote: false,
          isEmailed: false,
          isThirdParty: false,
          attachmentIds: [7],
        },
        5,
      ),
    ).rejects.toThrow('claim failed');

    expect(tx.ticket.update).not.toHaveBeenCalled();
    expect(tx.ticketAuditLog.create).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('creates staff post, counters, audit and immutable durable outbox in the same transaction', async () => {
    const existingTicket = ticket({ requesterEmail: 'customer@example.test' });
    const createdPost = post({ id: 101 });
    prisma.ticket.findUnique.mockResolvedValue(existingTicket);
    tx.ticketPost.create.mockResolvedValue(createdPost);
    tx.ticket.update.mockResolvedValue(existingTicket);

    await service.reply(
      1,
      {
        contents: 'An answer',
        isHtml: false,
        isNote: false,
        isEmailed: true, // hostile/legacy UI value must not claim delivery
        isThirdParty: false,
        ccEmails: ['visible@example.test'],
        bccEmails: ['hidden@example.test'],
      },
      5,
    );

    const postData = tx.ticketPost.create.mock.calls[0]![0].data;
    const outboxData = tx.outboundEmail.create.mock.calls[0]![0].data;
    expect(postData.isEmailed).toBe(false);
    expect(outboxData.postId).toBe(101);
    expect(outboxData.messageId).toBe(postData.messageId);
    expect(outboxData.recipients.create).toEqual(
      expect.arrayContaining([
        { email: 'customer@example.test', role: 'TO' },
        { email: 'visible@example.test', role: 'CC' },
        { email: 'hidden@example.test', role: 'BCC' },
      ]),
    );
    expect(tx.ticket.update).toHaveBeenCalled();
    expect(tx.ticketAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'REPLY' }) }),
    );
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('outbox-1');
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('refuses a public staff reply with no requester instead of showing a false queued/sent post', async () => {
    prisma.ticket.findUnique.mockResolvedValue(ticket({ requesterEmail: '' }));

    await expect(
      service.reply(
        1,
        {
          contents: 'Cannot be delivered',
          isHtml: false,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
        },
        5,
      ),
    ).rejects.toThrow('Ticket has no requester email');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.ticketPost.create).not.toHaveBeenCalled();
    expect(tx.outboundEmail.create).not.toHaveBeenCalled();
  });

  it('snapshots adopted reply attachments inside the same staff-reply outbox transaction', async () => {
    prisma.ticket.findUnique.mockResolvedValue(ticket({ requesterEmail: 'customer@example.test' }));
    tx.ticketPost.create.mockResolvedValue(post({ id: 202 }));
    tx.ticket.update.mockResolvedValue(ticket());
    tx.attachment.findMany.mockResolvedValue([
      {
        id: 7,
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 4096,
        sha1: 'a'.repeat(40),
        storageKey: 'tickets/1/invoice.pdf',
      },
    ]);

    await service.reply(
      1,
      {
        contents: 'Please see attachment',
        isHtml: false,
        isNote: false,
        isEmailed: false,
        isThirdParty: false,
        attachmentIds: [7],
      },
      5,
    );

    expect(tx.attachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ postId: 202, ticketId: 1 }) }),
    );
    const outboxData = tx.outboundEmail.create.mock.calls[0]![0].data;
    expect(outboxData.attachments.create).toEqual([
      {
        sourceAttachmentId: 7,
        fileName: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 4096,
        sha1: 'a'.repeat(40),
        storageKey: 'tickets/1/invoice.pdf',
      },
    ]);
  });

  it('commits note, note attachments, ticket flags and audit in one transaction', async () => {
    const existingTicket = ticket();
    const note = { id: 22, ticketId: 1, contents: 'private' };
    prisma.ticket.findUnique.mockResolvedValue(existingTicket);
    tx.ticketNote.create.mockResolvedValue(note);
    tx.ticket.update.mockResolvedValue(existingTicket);

    const result = await service.addNote(1, 'private', 5, [8]);

    expect(result).toBe(note);
    expect(attachments.linkToNote).toHaveBeenCalledWith([8], 22, 1, tx);
    expect(tx.ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ hasNotes: true, hasAttachments: true }),
      }),
    );
    expect(tx.ticketAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'NOTE' }) }),
    );
  });

  it('forwards reply-as-note attachment ids to the atomic note path', async () => {
    const note = { id: 22, ticketId: 1, contents: 'private' } as never;
    const addNote = vi.spyOn(service, 'addNote').mockResolvedValue(note);

    await service.reply(
      1,
      {
        contents: 'private',
        isHtml: false,
        isNote: true,
        isEmailed: false,
        isThirdParty: false,
        attachmentIds: [8],
      },
      5,
    );

    expect(addNote).toHaveBeenCalledWith(1, 'private', 5, [8]);
  });

  it('stores the trusted inbound Message-ID on the exact post', async () => {
    prisma.ticketPost.findFirst.mockResolvedValue(null);
    prisma.ticket.findUnique.mockResolvedValue(ticket());
    tx.ticketPost.create.mockResolvedValue(post({ messageId: '<inbound@example>' }));
    tx.ticket.update.mockResolvedValue(ticket());

    await service.reply(1, {
      contents: 'mail',
      isHtml: false,
      isNote: false,
      isEmailed: true,
      isThirdParty: false,
      creationMode: 'EMAIL',
      incomingMessageId: '  <inbound@example>  ',
    });

    expect(tx.ticketPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageId: '<inbound@example>' }),
      }),
    );
  });

  it.each(['not-bracketed', '<>', '<two words@example>', '<control\u0000@example>'])(
    'rejects an unsafe inbound Message-ID before any database write: %j',
    async (incomingMessageId) => {
      await expect(
        service.reply(1, {
          contents: 'mail',
          isHtml: false,
          isNote: false,
          isEmailed: true,
          isThirdParty: false,
          creationMode: 'EMAIL',
          incomingMessageId,
        }),
      ).rejects.toThrow('Invalid inbound Message-ID');

      expect(prisma.ticketPost.findFirst).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('returns an existing post for a duplicate Message-ID without side effects', async () => {
    const existing = post({ id: 77, messageId: '<duplicate@example>' });
    prisma.ticketPost.findFirst.mockResolvedValue(existing);

    const result = await service.reply(999, {
      contents: 'redelivery',
      isHtml: false,
      isNote: false,
      isEmailed: true,
      isThirdParty: false,
      creationMode: 'EMAIL',
      incomingMessageId: '<duplicate@example>',
    });

    expect(result).toBe(existing);
    expect(prisma.ticket.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('turns a concurrent Message-ID unique conflict into an idempotent no-op', async () => {
    const existing = post({ id: 77, messageId: '<race@example>' });
    prisma.ticketPost.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
    prisma.ticket.findUnique.mockResolvedValue(ticket());
    prisma.$transaction.mockRejectedValue({ code: 'P2002' });

    const result = await service.reply(1, {
      contents: 'redelivery',
      isHtml: false,
      isNote: false,
      isEmailed: true,
      isThirdParty: false,
      creationMode: 'EMAIL',
      incomingMessageId: '<race@example>',
    });

    expect(result).toBe(existing);
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('stores inbound Message-ID on the initial post and short-circuits redelivery before user creation', async () => {
    const createdTicket = ticket();
    prisma.ticketPost.findFirst.mockResolvedValueOnce(null);
    prisma.ticketStatus.findFirst.mockResolvedValue({ id: 1 });
    prisma.ticketPriority.findFirst.mockResolvedValue({ id: 1 });
    tx.ticket.create.mockResolvedValue({ ...createdTicket, posts: [{ id: 10 }] });
    tx.ticket.update.mockResolvedValue(createdTicket);

    await service.createTicket({
      subject: 'mail',
      contents: 'body',
      isHtml: false,
      departmentId: 2,
      requesterEmail: 'requester@example.test',
      requesterName: 'Requester',
      customFields: {},
      tags: [],
      creationMode: 'ALARIS',
      incomingMessageId: '<new@example>',
    });

    expect(tx.ticket.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          posts: { create: expect.objectContaining({ messageId: '<new@example>' }) },
        }),
      }),
    );

    const duplicateTicket = ticket({ id: 44, mask: 'TT-000044' });
    prisma.ticketPost.findFirst.mockResolvedValue({ ticketId: 44 });
    prisma.ticket.findUnique.mockResolvedValue(duplicateTicket);
    prisma.$transaction.mockClear();
    users.findOrCreate.mockClear();
    emitter.emit.mockClear();

    const result = await service.createTicket({
      subject: 'redelivery',
      contents: 'body',
      isHtml: false,
      departmentId: 2,
      requesterEmail: 'requester@example.test',
      requesterName: 'Requester',
      customFields: {},
      tags: [],
      creationMode: 'EMAIL',
      incomingMessageId: '<new@example>',
    });

    expect(result).toBe(duplicateTicket);
    expect(users.findOrCreate).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
