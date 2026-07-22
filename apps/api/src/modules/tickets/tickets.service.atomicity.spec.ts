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
    inboundMessageId: null,
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
  let notifications: Record<string, any>;
  let service: TicketsService;

  beforeEach(() => {
    tx = {
      ticket: { create: vi.fn(), update: vi.fn() },
      ticketPost: { create: vi.fn() },
      ticketNote: { create: vi.fn() },
      attachment: { findMany: vi.fn().mockResolvedValue([]) },
      outboundEmail: { create: vi.fn().mockResolvedValue({ id: 'outbox-1' }) },
      ticketAuditLog: { create: vi.fn().mockResolvedValue({}) },
      workflow: { findMany: vi.fn().mockResolvedValue([]) },
      workflowEmailEvent: { upsert: vi.fn() },
    };
    prisma = {
      ticket: { findUnique: vi.fn(), update: vi.fn() },
      ticketPost: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]), create: vi.fn() },
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
      createAutomatedTicketEmail: vi.fn().mockResolvedValue({ id: 'auto-outbox-1' }),
    };
    notifications = {
      queueWatcherNotificationsForUserReply: vi.fn().mockResolvedValue([]),
      queueAssignmentNotification: vi.fn().mockResolvedValue(undefined),
      wakeCommittedNotifications: vi.fn(),
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
      notifications as never,
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

  it('creates watcher notification commands inside the customer-reply transaction and wakes only after commit', async () => {
    const existingTicket = ticket({ requesterEmail: 'customer@example.test', mask: 'TT-000001' });
    const createdPost = post({ id: 55 });
    const updatedTicket = ticket({ requesterEmail: 'customer@example.test', mask: 'TT-000001' });
    prisma.ticket.findUnique.mockResolvedValue(existingTicket);
    tx.ticketPost.create.mockResolvedValue(createdPost);
    tx.ticket.update.mockResolvedValue(updatedTicket);
    notifications.queueWatcherNotificationsForUserReply.mockResolvedValue(['watcher-outbox-1']);

    await service.reply(1, {
      contents: 'Customer update',
      isHtml: false,
      isNote: false,
      isEmailed: true,
      isThirdParty: false,
      creationMode: 'EMAIL',
    });

    expect(notifications.queueWatcherNotificationsForUserReply).toHaveBeenCalledWith(tx, updatedTicket, 55);
    expect(notifications.wakeCommittedNotifications).toHaveBeenCalledWith(['watcher-outbox-1']);
  });

  it('creates the assignment audit and notification command in one transaction', async () => {
    const existingTicket = ticket({ ownerStaffId: null, departmentId: 2 });
    const updatedTicket = ticket({ ownerStaffId: 5, departmentId: 2 });
    prisma.ticket.findUnique.mockResolvedValue(existingTicket);
    prisma.staff.findUnique.mockResolvedValue({ id: 5, isEnabled: true });
    tx.ticket.update.mockResolvedValue(updatedTicket);
    tx.ticketAuditLog.create.mockResolvedValue({ id: 91 });
    notifications.queueAssignmentNotification.mockResolvedValue('assignment-outbox-1');

    await service.assign(1, { ownerStaffId: 5 }, 10);

    expect(tx.ticketAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'ASSIGN', newValue: '5' }) }),
    );
    expect(notifications.queueAssignmentNotification).toHaveBeenCalledWith(tx, updatedTicket, 5, 'audit:91');
    expect(notifications.wakeCommittedNotifications).toHaveBeenCalledWith(['assignment-outbox-1']);
  });

  it('queues an inbound autoresponder only from the accepting queue snapshot, inside ticket creation', async () => {
    prisma.ticketStatus.findFirst.mockResolvedValue({ id: 1 });
    prisma.ticketPriority.findFirst.mockResolvedValue({ id: 2 });
    tx.ticket.create.mockResolvedValue({ id: 44, posts: [{ id: 99 }] });
    tx.ticket.update.mockResolvedValue(ticket({ id: 44, mask: 'TT-000044' }));

    await service.createTicket({
      subject: 'Inbound',
      contents: 'body',
      isHtml: false,
      departmentId: 2,
      requesterEmail: 'customer@example.test',
      requesterName: 'Customer',
      tags: [],
      customFields: {},
      creationMode: 'EMAIL',
      inboundQueueId: 7,
      inboundSendAutoresponder: true,
    });

    expect(mail.createAutomatedTicketEmail).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        ticketId: 44,
        emailQueueId: 7,
        kind: 'AUTORESPONDER',
        templateKey: 'autoresponder',
        to: 'customer@example.test',
      }),
    );
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('auto-outbox-1');
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });

  it('fails closed for an EMAIL delivery with no accepting-queue autoresponder snapshot', async () => {
    prisma.ticketStatus.findFirst.mockResolvedValue({ id: 1 });
    prisma.ticketPriority.findFirst.mockResolvedValue({ id: 2 });
    tx.ticket.create.mockResolvedValue({ id: 45, posts: [{ id: 100 }] });
    tx.ticket.update.mockResolvedValue(ticket({ id: 45, mask: 'TT-000045' }));

    await service.createTicket({
      subject: 'Legacy inbound',
      contents: 'body',
      isHtml: false,
      departmentId: 2,
      requesterEmail: 'customer@example.test',
      requesterName: 'Customer',
      tags: [],
      customFields: {},
      creationMode: 'EMAIL',
    });

    expect(mail.createAutomatedTicketEmail).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
  });

  it('rolls back the ticket mutation, workflow event and outbox when durable workflow-event insertion fails', async () => {
    prisma.ticketStatus.findFirst.mockResolvedValue({ id: 1 });
    prisma.ticketPriority.findFirst.mockResolvedValue({ id: 2 });
    tx.ticket.create.mockResolvedValue({ id: 46, posts: [{ id: 101 }] });
    tx.ticket.update.mockResolvedValue(
      ticket({ id: 46, mask: 'TT-000046', requesterEmail: 'customer@example.test' }),
    );
    tx.workflow.findMany.mockResolvedValue([
      {
        id: 9,
        criteria: [],
        actions: [{ type: 'send_email', value: 'A durable update' }],
        isEnabled: true,
        sortOrder: 0,
        updatedAt: new Date('2026-07-22T10:00:00.000Z'),
      },
    ]);

    // A small transactional fake makes the assertion meaningful: mutators stage
    // effects, and only a successful callback publishes them.  The production
    // interactive transaction has the same all-or-nothing contract.
    const committed = { ticket: 0, workflowEvent: 0, outbox: 0 };
    let staged = { ticket: 0, workflowEvent: 0, outbox: 0 };
    tx.ticket.create.mockImplementation(async () => {
      staged.ticket += 1;
      return { id: 46, posts: [{ id: 101 }] };
    });
    tx.workflowEmailEvent.upsert.mockImplementation(async () => {
      staged.workflowEvent += 1;
      throw new Error('workflow event database outage');
    });
    tx.outboundEmail.create.mockImplementation(async () => {
      staged.outbox += 1;
      return { id: 'unexpected-outbox' };
    });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
      staged = { ticket: 0, workflowEvent: 0, outbox: 0 };
      const result = await callback(tx);
      Object.assign(committed, staged);
      return result;
    });

    await expect(
      service.createTicket({
        subject: 'Workflow rollback',
        contents: 'body',
        isHtml: false,
        departmentId: 2,
        requesterEmail: 'customer@example.test',
        requesterName: 'Customer',
        tags: [],
        customFields: {},
        // Avoid the unrelated autoresponder path: this test isolates workflow
        // customer mail, whose outbox is created only by the durable processor.
        creationMode: 'ALARIS',
      }),
    ).rejects.toThrow('workflow event database outage');

    expect(committed).toEqual({ ticket: 0, workflowEvent: 0, outbox: 0 });
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
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

  it('filters malformed historic Message-IDs and bounds outbound References', async () => {
    const id = (character: string) => `<${character.repeat(290)}@example.test>`;
    const [oldest, older, newer, newest] = ['a', 'b', 'c', 'd'].map(id);
    prisma.ticketPost.findMany.mockResolvedValue([
      { messageId: oldest },
      { messageId: '<bad\r\nBcc: injected@example.test>' },
      { messageId: older },
      { messageId: `<${'z'.repeat(600)}@example.test>` },
      { messageId: newer },
      { messageId: newest },
    ]);

    const threadingIds = await (
      service as unknown as { loadThreadingIds(ticketId: number): Promise<string[]> }
    ).loadThreadingIds(1);

    // Three legal IDs would exceed the 900-character header cap, so the
    // chronological suffix contains only the two newest valid entries.
    expect(threadingIds).toEqual([newer, newest]);
    expect(threadingIds.join(' ').length).toBeLessThanOrEqual(900);
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

  it('stores the trusted inbound Message-ID and separate inbound idempotency key on the exact post', async () => {
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
        data: expect.objectContaining({
          messageId: '<inbound@example>',
          inboundMessageId: '<inbound@example>',
        }),
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

  it('returns an existing post for a duplicate inbound Message-ID without side effects', async () => {
    const existing = post({
      id: 77,
      messageId: '<duplicate@example>',
      inboundMessageId: '<duplicate@example>',
    });
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
    expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith({
      where: { inboundMessageId: '<duplicate@example>' },
    });
  });

  it('turns a concurrent inbound Message-ID unique conflict into an idempotent no-op', async () => {
    const existing = post({
      id: 77,
      messageId: '<race@example>',
      inboundMessageId: '<race@example>',
    });
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
          posts: {
            create: expect.objectContaining({
              messageId: '<new@example>',
              inboundMessageId: '<new@example>',
            }),
          },
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

  it('does not let a staff outbound threading Message-ID suppress a distinct inbound message', async () => {
    const spoofedId = '<staff-outbound@example.test>';
    const staffOutbound = post({ id: 71, ticketId: 71, messageId: spoofedId, inboundMessageId: null });
    const inboundPost = post({ id: 72, ticketId: 1, messageId: spoofedId, inboundMessageId: spoofedId });
    prisma.ticketPost.findFirst.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      // A pre-fix lookup against `messageId` would return this staff post and incorrectly
      // treat the inbound delivery as already processed. The inbound namespace must not.
      if (where.messageId === spoofedId) return Promise.resolve(staffOutbound);
      return Promise.resolve(null);
    });
    prisma.ticket.findUnique.mockResolvedValue(ticket());
    tx.ticketPost.create.mockResolvedValue(inboundPost);
    tx.ticket.update.mockResolvedValue(ticket());

    const result = await service.reply(1, {
      contents: 'new inbound mail',
      isHtml: false,
      isNote: false,
      isEmailed: true,
      isThirdParty: false,
      creationMode: 'EMAIL',
      incomingMessageId: spoofedId,
    });

    expect(result).toBe(inboundPost);
    expect(prisma.ticketPost.findFirst).toHaveBeenCalledWith({
      where: { inboundMessageId: spoofedId },
    });
    expect(tx.ticketPost.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ messageId: spoofedId, inboundMessageId: spoofedId }),
      }),
    );
  });
});
