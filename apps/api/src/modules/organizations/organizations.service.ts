import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import type { CreateOrganizationDto, UpdateOrganizationDto, ListOrganizationsQueryDto } from './dto';
import type { Organization } from '@prisma/client';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminService: AdminService,
  ) {}

  async list(query: ListOrganizationsQueryDto): Promise<{ data: Organization[]; total: number }> {
    const { page, limit, search } = query;
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { city: { contains: search, mode: 'insensitive' as const } },
            { country: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};

    const [data, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.organization.count({ where }),
    ]);

    return { data, total };
  }

  async get(id: number): Promise<Organization> {
    const org = await this.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException(`Organization ${id} not found`);
    return org;
  }

  async create(dto: CreateOrganizationDto): Promise<Organization> {
    // Validate custom fields against ORGANIZATION scope definitions
    if (dto.customFields && typeof dto.customFields === 'object') {
      await this.adminService.validateCustomFields(
        'ORGANIZATION',
        dto.customFields as Record<string, unknown>,
      );
    }

    return this.prisma.organization.create({
      data: dto as Parameters<typeof this.prisma.organization.create>[0]['data'],
    });
  }

  async update(id: number, dto: UpdateOrganizationDto): Promise<Organization> {
    await this.get(id);

    // Validate custom fields against ORGANIZATION scope definitions (if provided)
    if (dto.customFields && typeof dto.customFields === 'object') {
      await this.adminService.validateCustomFields(
        'ORGANIZATION',
        dto.customFields as Record<string, unknown>,
      );
    }

    return this.prisma.organization.update({
      where: { id },
      data: dto as Parameters<typeof this.prisma.organization.update>[0]['data'],
    });
  }

  async delete(id: number): Promise<void> {
    await this.get(id);
    await this.prisma.organization.delete({ where: { id } });
  }
}
