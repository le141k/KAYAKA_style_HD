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

  /**
   * Public-facing department list for the unauthenticated client submit form.
   * Returns only PUBLIC-type departments and only the id + title (no sensitive
   * fields like staff assignments, email queues, type/app routing internals).
   */
  async listPublic(): Promise<{ id: number; title: string }[]> {
    return this.prisma.department.findMany({
      where: { type: 'PUBLIC' },
      orderBy: [{ displayOrder: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true },
    });
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
