import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from './notification.service';
import type { MailService } from '../mail/mail.service';

function makeTransactionMock() {
  return {
    staff: { findUnique: vi.fn() },
    ticketWatcher: { findMany: vi.fn() },
  };
}

function makeMailMock(): MailService {
  return {
    createInternalNotificationEmail: vi
      .fn()
      .mockImplementation(async (_tx: unknown, input: { idempotencyKey: string }) => ({
        id: `command:${input.idempotencyKey}`,
      })),
    enqueueOutbound: vi.fn().mockResolvedValue(undefined),
    // This is intentionally present as a tripwire: NotificationService must
    // never use the legacy inline SMTP/template path.
    sendTemplate: vi.fn(),
  } as unknown as MailService;
}

const MOCK_TICKET = {
  id: 1,
  mask: 'TT-000001',
  subject: 'Network issue',
  requesterEmail: 'u@u.com',
  departmentId: 1,
};
const MOCK_STAFF = {
  id: 5,
  email: 'staff@example.com',
  firstName: 'Alex',
  lastName: 'Smith',
  isEnabled: true,
  staffGroup: { isAdmin: false },
  departments: [{ departmentId: 1 }],
};

describe('NotificationService', () => {
  let service: NotificationService;
  let tx: ReturnType<typeof makeTransactionMock>;
  let mail: MailService;

  beforeEach(() => {
    tx = makeTransactionMock();
    mail = makeMailMock();
    service = new NotificationService(mail);
  });

  describe('queueAssignmentNotification', () => {
    it('creates an immutable durable command from the assignment audit source', async () => {
      tx.staff.findUnique.mockResolvedValue(MOCK_STAFF);

      const id = await service.queueAssignmentNotification(tx as never, MOCK_TICKET as never, 5, 'audit:42');

      expect(id).toBe('command:internal:assignment:audit:42:staff:5');
      expect(mail.createInternalNotificationEmail).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          ticketId: 1,
          templateKey: 'notify_staff_assigned',
          to: 'staff@example.com',
          idempotencyKey: 'internal:assignment:audit:42:staff:5',
          vars: expect.objectContaining({
            mask: 'TT-000001',
            subject: 'Network issue',
            staffName: 'Alex Smith',
          }),
        }),
      );
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });

    it('does not disclose an assignment to a staff member outside the current department', async () => {
      tx.staff.findUnique.mockResolvedValue({ ...MOCK_STAFF, departments: [{ departmentId: 2 }] });

      await expect(
        service.queueAssignmentNotification(tx as never, MOCK_TICKET as never, 5, 'audit:42'),
      ).resolves.toBeUndefined();
      expect(mail.createInternalNotificationEmail).not.toHaveBeenCalled();
    });

    it('does not queue an alert for a disabled/missing assignee', async () => {
      tx.staff.findUnique.mockResolvedValue({ ...MOCK_STAFF, isEnabled: false });

      await expect(
        service.queueAssignmentNotification(tx as never, MOCK_TICKET as never, 5, 'audit:42'),
      ).resolves.toBeUndefined();
      expect(mail.createInternalNotificationEmail).not.toHaveBeenCalled();
    });
  });

  describe('queueWatcherNotificationsForUserReply', () => {
    it('creates one command per eligible watcher with TicketPost-based idempotency keys', async () => {
      tx.ticketWatcher.findMany.mockResolvedValue([
        { staffId: 5, staff: { ...MOCK_STAFF, id: 5 } },
        {
          staffId: 6,
          staff: { id: 6, email: 'agent2@example.com', firstName: 'Bob', lastName: 'Jones', isEnabled: true },
        },
      ]);

      const ids = await service.queueWatcherNotificationsForUserReply(tx as never, MOCK_TICKET as never, 77);

      expect(ids).toEqual([
        'command:internal:watcher-reply:post:77:staff:5',
        'command:internal:watcher-reply:post:77:staff:6',
      ]);
      expect(mail.createInternalNotificationEmail).toHaveBeenNthCalledWith(
        1,
        tx,
        expect.objectContaining({
          templateKey: 'notify_staff_user_replied',
          idempotencyKey: 'internal:watcher-reply:post:77:staff:5',
        }),
      );
      expect(mail.createInternalNotificationEmail).toHaveBeenNthCalledWith(
        2,
        tx,
        expect.objectContaining({ idempotencyKey: 'internal:watcher-reply:post:77:staff:6' }),
      );
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });

    it('checks watcher scope against the ticket department inside the caller transaction', async () => {
      tx.ticketWatcher.findMany.mockResolvedValue([]);

      await service.queueWatcherNotificationsForUserReply(
        tx as never,
        { ...MOCK_TICKET, departmentId: 2 } as never,
        77,
      );

      expect(tx.ticketWatcher.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            ticketId: 1,
            staff: expect.objectContaining({
              is: expect.objectContaining({
                OR: expect.arrayContaining([
                  expect.objectContaining({ departments: { some: { departmentId: 2 } } }),
                ]),
              }),
            }),
          }),
        }),
      );
    });

    it('rejects an invalid post id rather than manufacturing an idempotency key', async () => {
      await expect(
        service.queueWatcherNotificationsForUserReply(tx as never, MOCK_TICKET as never, 0),
      ).rejects.toThrow('source post id is invalid');
    });
  });

  it('wakes committed commands through the durable outbox only', async () => {
    service.wakeCommittedNotifications(['one', 'one', 'two']);
    await Promise.resolve();

    expect(mail.enqueueOutbound).toHaveBeenCalledTimes(2);
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('one');
    expect(mail.enqueueOutbound).toHaveBeenCalledWith('two');
    expect(mail.sendTemplate).not.toHaveBeenCalled();
  });
});
