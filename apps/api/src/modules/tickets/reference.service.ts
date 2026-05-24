import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { TicketStatus, TicketPriority, TicketType } from '@prisma/client';
import { z } from 'zod';

export const CreateStatusSchema = z.object({
  title: z.string().min(1).max(100),
  displayOrder: z.number().int().default(0),
  markAsResolved: z.boolean().default(false),
  color: z.string().default(''),
  bgColor: z.string().default(''),
  displayIcon: z.string().default(''),
  triggersSurvey: z.boolean().default(false),
  isDefault: z.boolean().default(false),
});
export type CreateStatusDto = z.infer<typeof CreateStatusSchema>;

export const CreatePrioritySchema = z.object({
  title: z.string().min(1).max(100),
  displayOrder: z.number().int().default(0),
  color: z.string().default(''),
  bgColor: z.string().default(''),
});
export type CreatePriorityDto = z.infer<typeof CreatePrioritySchema>;

export const CreateTypeSchema = z.object({
  title: z.string().min(1).max(100),
  displayOrder: z.number().int().default(0),
  displayIcon: z.string().default(''),
});
export type CreateTypeDto = z.infer<typeof CreateTypeSchema>;

@Injectable()
export class ReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Statuses ───

  listStatuses(): Promise<TicketStatus[]> {
    return this.prisma.ticketStatus.findMany({ orderBy: { displayOrder: 'asc' } });
  }

  async createStatus(dto: CreateStatusDto): Promise<TicketStatus> {
    return this.prisma.ticketStatus.create({ data: dto });
  }

  async updateStatus(id: number, dto: Partial<CreateStatusDto>): Promise<TicketStatus> {
    const s = await this.prisma.ticketStatus.findUnique({ where: { id } });
    if (!s) throw new NotFoundException(`TicketStatus ${id} not found`);
    return this.prisma.ticketStatus.update({ where: { id }, data: dto });
  }

  async deleteStatus(id: number): Promise<void> {
    const s = await this.prisma.ticketStatus.findUnique({ where: { id } });
    if (!s) throw new NotFoundException(`TicketStatus ${id} not found`);
    // U-high: pre-check so the client receives 409 instead of a raw P2003 500
    const ticketCount = await this.prisma.ticket.count({ where: { statusId: id, mergedIntoId: null } });
    if (ticketCount > 0) {
      throw new ConflictException(
        `Cannot delete: still in use by ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}`,
      );
    }
    await this.prisma.ticketStatus.delete({ where: { id } });
  }

  // ─── Priorities ───

  listPriorities(): Promise<TicketPriority[]> {
    return this.prisma.ticketPriority.findMany({ orderBy: { displayOrder: 'asc' } });
  }

  /** Public projection (id + title only) for the client portal priority picker. */
  listPrioritiesPublic(): Promise<{ id: number; title: string }[]> {
    return this.prisma.ticketPriority.findMany({
      select: { id: true, title: true },
      orderBy: { displayOrder: 'asc' },
    });
  }

  async createPriority(dto: CreatePriorityDto): Promise<TicketPriority> {
    return this.prisma.ticketPriority.create({ data: dto });
  }

  async updatePriority(id: number, dto: Partial<CreatePriorityDto>): Promise<TicketPriority> {
    const p = await this.prisma.ticketPriority.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`TicketPriority ${id} not found`);
    return this.prisma.ticketPriority.update({ where: { id }, data: dto });
  }

  async deletePriority(id: number): Promise<void> {
    const p = await this.prisma.ticketPriority.findUnique({ where: { id } });
    if (!p) throw new NotFoundException(`TicketPriority ${id} not found`);
    const ticketCount = await this.prisma.ticket.count({ where: { priorityId: id, mergedIntoId: null } });
    if (ticketCount > 0) {
      throw new ConflictException(
        `Cannot delete: still in use by ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}`,
      );
    }
    await this.prisma.ticketPriority.delete({ where: { id } });
  }

  // ─── Types ───

  listTypes(): Promise<TicketType[]> {
    return this.prisma.ticketType.findMany({ orderBy: { displayOrder: 'asc' } });
  }

  async createType(dto: CreateTypeDto): Promise<TicketType> {
    return this.prisma.ticketType.create({ data: dto });
  }

  async updateType(id: number, dto: Partial<CreateTypeDto>): Promise<TicketType> {
    const t = await this.prisma.ticketType.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`TicketType ${id} not found`);
    return this.prisma.ticketType.update({ where: { id }, data: dto });
  }

  async deleteType(id: number): Promise<void> {
    const t = await this.prisma.ticketType.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`TicketType ${id} not found`);
    const ticketCount = await this.prisma.ticket.count({ where: { typeId: id, mergedIntoId: null } });
    if (ticketCount > 0) {
      throw new ConflictException(
        `Cannot delete: still in use by ${ticketCount} ticket${ticketCount === 1 ? '' : 's'}`,
      );
    }
    await this.prisma.ticketType.delete({ where: { id } });
  }
}
