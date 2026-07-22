import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoCloseProcessor } from './auto-close.processor';
import { enqueueWorkflowEmailEvent } from './workflow-email-event.service';

vi.mock('./workflow-email-event.service', () => ({
  enqueueWorkflowEmailEvent: vi.fn(),
}));

function makeHarness(updateCount = 1) {
  const tx = {
    ticket: { updateMany: vi.fn().mockResolvedValue({ count: updateCount }) },
    ticketAuditLog: { create: vi.fn().mockResolvedValue({ id: 901 }) },
  };
  const prisma = {
    ticketStatus: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({ id: 3, title: 'Pending' })
        .mockResolvedValueOnce({ id: 4, markAsResolved: true }),
    },
    ticket: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 77,
          mask: 'TT-000077',
          subject: 'Idle ticket',
          requesterEmail: 'customer@example.test',
          requesterName: 'Customer',
        },
      ]),
    },
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const mail = {
    createAutomatedTicketEmail: vi.fn().mockResolvedValue({ id: 'auto-close-77' }),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
  };
  const emitter = { emit: vi.fn() };
  return {
    tx,
    prisma,
    mail,
    emitter,
    processor: new AutoCloseProcessor(prisma as never, mail as never, emitter as never),
  };
}

describe('AutoCloseProcessor', () => {
  beforeEach(() => {
    vi.mocked(enqueueWorkflowEmailEvent).mockReset().mockResolvedValue(undefined);
  });

  it('atomically fences close/audit/durable customer command and wakes the outbox after commit', async () => {
    const { tx, prisma, mail, emitter, processor } = makeHarness();

    await processor.process({ name: 'auto-close' } as never);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.ticket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 77,
          statusId: 3,
          isResolved: false,
          mergedIntoId: null,
          lastActivityAt: { lt: expect.any(Date) },
        }),
      }),
    );
    expect(tx.ticketAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'AUTO_CLOSE' }) }),
    );
    expect(mail.createAutomatedTicketEmail).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        ticketId: 77,
        kind: 'AUTO_CLOSE',
        templateKey: 'ticket_auto_closed',
        to: 'customer@example.test',
      }),
    );
    expect(enqueueWorkflowEmailEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: 77, statusId: 4, isResolved: true }),
      'ticket.status_changed',
      'ticket-audit:901',
    );
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('auto-close-77');
    expect(emitter.emit).toHaveBeenCalledWith('ticket.status_changed', { ticketId: 77 });
  });

  it('does not audit or email when another worker/staff update wins the close fence', async () => {
    const { tx, mail, processor } = makeHarness(0);

    await processor.process({ name: 'auto-close' } as never);

    expect(tx.ticketAuditLog.create).not.toHaveBeenCalled();
    expect(mail.createAutomatedTicketEmail).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
  });

  it('still emits the committed status event when an idle ticket has no safe email recipient', async () => {
    const { tx, prisma, mail, emitter, processor } = makeHarness();
    prisma.ticket.findMany.mockResolvedValue([
      {
        id: 78,
        mask: 'TT-000078',
        subject: 'Requester-less idle ticket',
        requesterEmail: '',
        requesterName: '',
      },
    ]);
    tx.ticketAuditLog.create.mockResolvedValue({ id: 902 });

    await processor.process({ name: 'auto-close' } as never);

    expect(enqueueWorkflowEmailEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: 78, statusId: 4, isResolved: true }),
      'ticket.status_changed',
      'ticket-audit:902',
    );
    expect(mail.createAutomatedTicketEmail).not.toHaveBeenCalled();
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledWith('ticket.status_changed', { ticketId: 78 });
  });

  it('does not wake an auto-close email or emit a workflow event before the transaction commits', async () => {
    const { tx, prisma, mail, emitter, processor } = makeHarness();
    vi.mocked(enqueueWorkflowEmailEvent).mockReset().mockResolvedValue(undefined);

    let finishCallback!: () => void;
    const callbackFinished = new Promise<void>((resolve) => {
      finishCallback = resolve;
    });
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    prisma.$transaction.mockImplementation(async (callback: (client: typeof tx) => unknown) => {
      const result = await callback(tx);
      finishCallback();
      await commitGate;
      return result;
    });

    const pending = processor.process({ name: 'auto-close' } as never);
    await callbackFinished;

    expect(enqueueWorkflowEmailEvent).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ id: 77, statusId: 4 }),
      'ticket.status_changed',
      'ticket-audit:901',
    );
    // Anti-false-green barrier: both actions must stay outside the interactive
    // transaction, otherwise an uncommitted close becomes externally visible.
    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();

    releaseCommit();
    await pending;
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('auto-close-77');
    expect(emitter.emit).toHaveBeenCalledWith('ticket.status_changed', { ticketId: 77 });
  });

  it('does not wake or emit when durable status-workflow insertion aborts the close transaction', async () => {
    const { mail, emitter, processor } = makeHarness();
    vi.mocked(enqueueWorkflowEmailEvent)
      .mockReset()
      .mockRejectedValue(new Error('workflow event unavailable'));

    await processor.process({ name: 'auto-close' } as never);

    expect(mail.enqueueOutbound).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
