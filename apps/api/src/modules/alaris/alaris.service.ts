import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TicketsService } from '../tickets/tickets.service';
import type { AlarisEvent, Ticket } from '@prisma/client';

export interface AlarisWebhookPayload {
  externalId: string;
  severity: string;
  message: string;
  [key: string]: unknown;
}

export interface AlarisIngestResult {
  event: AlarisEvent;
  ticket: Ticket;
  deduplicated: boolean;
}

@Injectable()
export class AlarisService {
  private readonly logger = new Logger(AlarisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ticketsService: TicketsService,
  ) {}

  /**
   * Ingest an Alaris monitoring event.
   * Deduplicates by externalId — if already processed, returns the existing event.
   */
  async ingest(payload: AlarisWebhookPayload): Promise<AlarisIngestResult> {
    // Deduplication check
    const existing = await this.prisma.alarisEvent.findUnique({
      where: { externalId: payload.externalId },
      include: { ticket: true },
    });

    if (existing) {
      this.logger.warn(`Alaris event ${payload.externalId} already processed — deduped`);
      if (!existing.ticket) {
        throw new ConflictException(`Alaris event ${payload.externalId} exists but has no ticket`);
      }
      return { event: existing, ticket: existing.ticket, deduplicated: true };
    }

    // Resolve default department + status + priority for ALARIS tickets
    const dept = await this.prisma.department.findFirst({ orderBy: { isDefault: 'desc' } });
    const departmentId = dept?.id ?? 1;

    // Resolve the "Alaris Incident" TicketType by title
    const alarisType = await this.prisma.ticketType.findFirst({
      where: { title: { equals: 'Alaris Incident', mode: 'insensitive' } },
    });
    const typeId = alarisType?.id ?? undefined;

    // Build subject from message
    const subject = `[ALARIS-AUTO] ${payload.message}`.slice(0, 500);

    // Create the ticket via TicketsService (no staffId = SYSTEM creator)
    const ticket = await this.ticketsService.createTicket({
      subject,
      contents: JSON.stringify(payload, null, 2),
      isHtml: false,
      departmentId,
      typeId,
      requesterEmail: 'alaris@system.internal',
      requesterName: 'Alaris Monitor',
      creationMode: 'ALARIS',
      ipAddress: '0.0.0.0',
      tags: [`severity:${payload.severity}`],
      customFields: {},
    });

    // Record the Alaris event linked to the ticket
    const event = await this.prisma.alarisEvent.create({
      data: {
        externalId: payload.externalId,
        severity: payload.severity,
        payload: payload as object,
        ticketId: ticket.id,
      },
    });

    this.logger.log(
      `Alaris event ${payload.externalId} → ticket ${ticket.mask} (severity=${payload.severity})`,
    );

    return { event, ticket, deduplicated: false };
  }
}
