/**
 * Ticket-linking feature (M0) — the backbone of the 23T broker model: a client
 * ticket linked to its supplier ticket via TicketLink. Covers list (both
 * directions), add (dedupe + self-link guard), and remove (scoped to the ticket).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TicketsService } from './tickets.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { UsersService } from '../users/users.service';
import type { SlaService } from '../sla/sla.service';
import type { MailService } from '../mail/mail.service';
import type { AdminService } from '../admin/admin.service';
import type { EventEmitter2 } from '@nestjs/event-emitter';

function makePrismaMock() {
  return {
    ticket: { findUnique: vi.fn().mockResolvedValue({ id: 1 }) },
    ticketLink: {
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  } as unknown as PrismaService;
}

describe('TicketsService — ticket links', () => {
  let service: TicketsService;
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = new TicketsService(
      prisma as unknown as PrismaService,
      {} as unknown as UsersService,
      {} as unknown as SlaService,
      { emit: vi.fn() } as unknown as EventEmitter2,
      {} as unknown as MailService,
      {} as unknown as AdminService,
    );
  });

  describe('addLink', () => {
    it('creates a link with the given linkType', async () => {
      (prisma.ticketLink.create as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 9,
        sourceId: 1,
        targetId: 2,
        linkType: 'supplier',
      });

      const res = await service.addLink(1, { targetId: 2, linkType: 'supplier' });

      expect(res).toEqual({ linkId: 9, linkType: 'supplier', targetId: 2 });
      expect(prisma.ticketLink.create).toHaveBeenCalledWith({
        data: { sourceId: 1, targetId: 2, linkType: 'supplier' },
      });
    });

    it('rejects linking a ticket to itself', async () => {
      await expect(service.addLink(1, { targetId: 1, linkType: 'related' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects a duplicate link in either direction', async () => {
      (prisma.ticketLink.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 5 });
      await expect(service.addLink(1, { targetId: 2, linkType: 'supplier' })).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.ticketLink.create).not.toHaveBeenCalled();
    });
  });

  describe('listLinks', () => {
    it('flattens both directions to the counterpart, inverting the label for inbound links', async () => {
      (prisma.ticketLink.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
        // ticket 1 is the SOURCE → counterpart is the target, label kept ('supplier')
        {
          id: 1,
          sourceId: 1,
          targetId: 2,
          linkType: 'supplier',
          target: { id: 2, mask: 'TT-2', subject: 'Vendor', isResolved: false, status: { title: 'Open' } },
          source: { id: 1, mask: 'TT-1', subject: 'Client', isResolved: false, status: null },
        },
        // ticket 1 is the TARGET → counterpart is the source, label inverted (supplier→client)
        {
          id: 2,
          sourceId: 3,
          targetId: 1,
          linkType: 'supplier',
          target: { id: 1, mask: 'TT-1', subject: 'Client', isResolved: false, status: null },
          source: { id: 3, mask: 'TT-3', subject: 'Other', isResolved: true, status: { title: 'Closed' } },
        },
      ]);

      const res = await service.listLinks(1);

      expect(res).toEqual([
        {
          linkId: 1,
          linkType: 'supplier',
          ticket: { id: 2, mask: 'TT-2', subject: 'Vendor', status: 'Open', isResolved: false },
        },
        {
          linkId: 2,
          linkType: 'client',
          ticket: { id: 3, mask: 'TT-3', subject: 'Other', status: 'Closed', isResolved: true },
        },
      ]);
    });
  });

  describe('spawnSupplierTicket', () => {
    it('creates a Vendor-Issue ticket for the carrier and links it as supplier', async () => {
      (prisma.ticket.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 10,
        subject: 'SMS not delivered to ES',
        departmentId: 2,
      });
      (prisma as unknown as { ticketType: { findFirst: ReturnType<typeof vi.fn> } }).ticketType = {
        findFirst: vi.fn().mockResolvedValue({ id: 7 }),
      };

      const createSpy = vi
        .spyOn(service, 'createTicket')
        .mockResolvedValue({ id: 20, subject: '[Supplier] SMS not delivered to ES' } as never);
      const linkSpy = vi
        .spyOn(service, 'addLink')
        .mockResolvedValue({ linkId: 99, linkType: 'supplier', targetId: 20 });

      const res = await service.spawnSupplierTicket(
        10,
        { supplierEmail: 'noc@sinch.com', supplierName: 'Sinch', contents: 'Please fix the ES route' },
        5,
      );

      // Vendor Issue type resolved, requester = carrier, department inherited.
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          requesterEmail: 'noc@sinch.com',
          requesterName: 'Sinch',
          typeId: 7,
          departmentId: 2,
          creationMode: 'STAFF',
        }),
        5,
      );
      // Auto-linked back to the client ticket as a supplier link.
      expect(linkSpy).toHaveBeenCalledWith(10, { targetId: 20, linkType: 'supplier' });
      expect(res).toEqual({
        ticket: { id: 20, subject: '[Supplier] SMS not delivered to ES' },
        linkId: 99,
        clientTicketId: 10,
      });
    });
  });

  describe('removeLink', () => {
    it('deletes a link that involves the ticket', async () => {
      (prisma.ticketLink.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        sourceId: 1,
        targetId: 2,
      });
      await service.removeLink(1, 7);
      expect(prisma.ticketLink.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    });

    it('throws when the link does not involve the ticket', async () => {
      (prisma.ticketLink.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: 7,
        sourceId: 8,
        targetId: 9,
      });
      await expect(service.removeLink(1, 7)).rejects.toThrow(NotFoundException);
      expect(prisma.ticketLink.delete).not.toHaveBeenCalled();
    });
  });
});
