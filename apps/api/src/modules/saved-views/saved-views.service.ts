import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateSavedViewDto } from './dto';

/**
 * Saved ticket-list views: a named set of list filters scoped to one staff
 * member. All reads/writes are constrained to the owning staffId.
 */
@Injectable()
export class SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  list(staffId: number) {
    return this.prisma.savedView.findMany({
      where: { staffId },
      orderBy: { name: 'asc' },
    });
  }

  create(staffId: number, dto: CreateSavedViewDto) {
    return this.prisma.savedView.create({
      data: {
        staffId,
        name: dto.name,
        filters: dto.filters as Prisma.InputJsonValue,
      },
    });
  }

  async delete(staffId: number, id: number) {
    // Scope the delete to the owner so one staff can't remove another's view.
    const view = await this.prisma.savedView.findFirst({ where: { id, staffId } });
    if (!view) throw new NotFoundException(`SavedView ${id} not found`);
    await this.prisma.savedView.delete({ where: { id } });
  }
}
