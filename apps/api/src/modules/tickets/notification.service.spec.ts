import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from './notification.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';

function makePrismaMock() {
  return {
    ticket: { findUnique: vi.fn() },
    staff: { findUnique: vi.fn() },
    ticketWatcher: { findMany: vi.fn() },
  } as unknown as PrismaService;
}

function makeMailMock(): MailService {
  return { sendTemplate: vi.fn().mockResolvedValue(undefined) } as unknown as MailService;
}

const MOCK_TICKET = { id: 1, mask: 'TT-000001', subject: 'Network issue', requesterEmail: 'u@u.com' };
const MOCK_STAFF = {
  id: 5,
  email: 'staff@example.com',
  firstName: 'Alex',
  lastName: 'Smith',
  isEnabled: true,
};

describe('NotificationService', () => {
  let service: NotificationService;
  let prisma: ReturnType<typeof makePrismaMock>;
  let mail: MailService;

  beforeEach(() => {
    prisma = makePrismaMock();
    mail = makeMailMock();
    service = new NotificationService(prisma as unknown as PrismaService, mail);
  });

  // ─── notifyOnAssign ──────────────────────────────────────────────────────────

  describe('notifyOnAssign', () => {
    it('sends notify_staff_assigned email to the assignee', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TICKET);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);

      await service.notifyOnAssign(1, 5);

      expect(mail.sendTemplate).toHaveBeenCalledWith(
        MOCK_STAFF.email,
        'notify_staff_assigned',
        'en',
        expect.objectContaining({ mask: 'TT-000001', subject: 'Network issue' }),
      );
    });

    it('does nothing when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);

      await service.notifyOnAssign(999, 5);
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });

    it('does nothing when staff not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TICKET);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await service.notifyOnAssign(1, 999);
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });

    it('does nothing when mailService is not injected', async () => {
      const serviceNoMail = new NotificationService(prisma as unknown as PrismaService, undefined);
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TICKET);
      await expect(serviceNoMail.notifyOnAssign(1, 5)).resolves.toBeUndefined();
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });

    it('swallows errors from sendTemplate without throwing', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TICKET);
      (prisma.staff.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_STAFF);
      (mail.sendTemplate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('SMTP down'));

      await expect(service.notifyOnAssign(1, 5)).resolves.toBeUndefined();
    });
  });

  // ─── notifyWatchersOnUserReply ───────────────────────────────────────────────

  describe('notifyWatchersOnUserReply', () => {
    it('sends notify_staff_user_replied to all enabled watchers', async () => {
      const watchers = [
        { staffId: 5, staff: { ...MOCK_STAFF, id: 5 } },
        {
          staffId: 6,
          staff: { id: 6, email: 'agent2@example.com', firstName: 'Bob', lastName: 'Jones', isEnabled: true },
        },
      ];
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TICKET);
      (prisma.ticketWatcher.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(watchers);

      await service.notifyWatchersOnUserReply(1);

      expect(mail.sendTemplate).toHaveBeenCalledTimes(2);
      expect(mail.sendTemplate).toHaveBeenCalledWith(
        'staff@example.com',
        'notify_staff_user_replied',
        'en',
        expect.objectContaining({ mask: 'TT-000001' }),
      );
    });

    it('does not email disabled watchers', async () => {
      const watchers = [
        { staffId: 5, staff: { ...MOCK_STAFF, id: 5 } },
        {
          staffId: 7,
          staff: { id: 7, email: 'disabled@example.com', firstName: 'X', lastName: 'Y', isEnabled: false },
        },
      ];
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_TICKET);
      (prisma.ticketWatcher.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(watchers);

      await service.notifyWatchersOnUserReply(1);

      expect(mail.sendTemplate).toHaveBeenCalledTimes(1);
      expect(mail.sendTemplate).toHaveBeenCalledWith(
        'staff@example.com',
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('does nothing when ticket not found', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

      await service.notifyWatchersOnUserReply(999);
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });

    it('does nothing when mailService is not injected', async () => {
      const serviceNoMail = new NotificationService(prisma as unknown as PrismaService, undefined);
      await expect(serviceNoMail.notifyWatchersOnUserReply(1)).resolves.toBeUndefined();
    });

    it('swallows errors without throwing', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
      await expect(service.notifyWatchersOnUserReply(1)).resolves.toBeUndefined();
    });
  });
});
