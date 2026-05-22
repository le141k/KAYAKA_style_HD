import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { CreateDepartmentDto, UpdateDepartmentDto } from './dto';
import type { Department } from '@prisma/client';

export type DepartmentWithChildren = Department & { children: DepartmentWithChildren[] };

@Injectable()
export class DepartmentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Return department tree (roots + their children recursively). */
  async listTree(): Promise<DepartmentWithChildren[]> {
    const all = await this.prisma.department.findMany({
      include: { children: { include: { children: true } } },
      where: { parentId: null },
      orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }],
    });
    return all as unknown as DepartmentWithChildren[];
  }

  async list(): Promise<Department[]> {
    return this.prisma.department.findMany({ orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }] });
  }

  async get(id: number): Promise<Department & { children: Department[] }> {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      include: { children: true },
    });
    if (!dept) throw new NotFoundException(`Department ${id} not found`);
    return dept;
  }

  async create(dto: CreateDepartmentDto): Promise<Department> {
    if (dto.parentId) {
      const parent = await this.prisma.department.findUnique({ where: { id: dto.parentId } });
      if (!parent) throw new NotFoundException(`Parent department ${dto.parentId} not found`);
    }
    return this.prisma.department.create({ data: dto });
  }

  async update(id: number, dto: UpdateDepartmentDto): Promise<Department> {
    await this.get(id);
    return this.prisma.department.update({ where: { id }, data: dto });
  }

  async delete(id: number): Promise<void> {
    await this.get(id);
    await this.prisma.department.delete({ where: { id } });
  }
}
