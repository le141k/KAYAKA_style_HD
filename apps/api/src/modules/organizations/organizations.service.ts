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
    org.customFields = (await this.adminService.decryptCustomFields(
      'ORGANIZATION',
      org.customFields as Record<string, unknown>,
    )) as object;
    return org;
  }

  async create(dto: CreateOrganizationDto): Promise<Organization> {
    // Validate + encrypt custom fields against ORGANIZATION scope definitions
    let cf = dto.customFields as Record<string, unknown> | undefined;
    if (cf && typeof cf === 'object') {
      await this.adminService.validateCustomFields('ORGANIZATION', cf);
      cf = await this.adminService.encryptCustomFields('ORGANIZATION', cf);
    }

    return this.prisma.organization.create({
      data: {
        ...dto,
        ...(cf !== undefined ? { customFields: cf as object } : {}),
      } as Parameters<typeof this.prisma.organization.create>[0]['data'],
    });
  }

  async update(id: number, dto: UpdateOrganizationDto): Promise<Organization> {
    await this.get(id);

    // Validate + encrypt custom fields against ORGANIZATION scope definitions (if provided)
    let cf = dto.customFields as Record<string, unknown> | undefined;
    if (cf && typeof cf === 'object') {
      await this.adminService.validateCustomFields('ORGANIZATION', cf);
      cf = await this.adminService.encryptCustomFields('ORGANIZATION', cf);
    }

    return this.prisma.organization.update({
      where: { id },
      data: {
        ...dto,
        ...(cf !== undefined ? { customFields: cf as object } : {}),
      } as Parameters<typeof this.prisma.organization.update>[0]['data'],
    });
  }

  async delete(id: number): Promise<void> {
    await this.get(id);
    await this.prisma.organization.delete({ where: { id } });
  }
}
