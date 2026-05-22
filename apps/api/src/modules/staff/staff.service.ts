import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { hashPassword } from '../../auth/password.util';
import type {
  CreateStaffDto,
  UpdateStaffDto,
  CreateStaffGroupDto,
  UpdateStaffGroupDto,
  ListStaffQueryDto,
} from './dto';
import type { Staff, StaffGroup } from '@prisma/client';

/** Safe staff shape — never exposes passwordHash. */
export type SafeStaff = Omit<Staff, 'passwordHash'>;

const SAFE_STAFF_SELECT = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  designation: true,
  signature: true,
  mobileNumber: true,
  timezone: true,
  isEnabled: true,
  staffGroupId: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────── Staff Groups ───────────────────

  async listGroups(): Promise<StaffGroup[]> {
    return this.prisma.staffGroup.findMany({ orderBy: { id: 'asc' } });
  }

  async getGroup(id: number): Promise<StaffGroup> {
    const group = await this.prisma.staffGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException(`StaffGroup ${id} not found`);
    return group;
  }

  async createGroup(dto: CreateStaffGroupDto): Promise<StaffGroup> {
    return this.prisma.staffGroup.create({ data: dto });
  }

  async updateGroup(id: number, dto: UpdateStaffGroupDto): Promise<StaffGroup> {
    await this.getGroup(id);
    return this.prisma.staffGroup.update({ where: { id }, data: dto });
  }

  // ─────────────────── Staff Members ───────────────────

  async list(query: ListStaffQueryDto): Promise<{ data: SafeStaff[]; total: number }> {
    const { page, limit, groupId, search, enabled } = query;
    const where = {
      ...(groupId !== undefined && { staffGroupId: groupId }),
      ...(enabled !== undefined && { isEnabled: enabled }),
      ...(search && {
        OR: [
          { email: { contains: search, mode: 'insensitive' as const } },
          { firstName: { contains: search, mode: 'insensitive' as const } },
          { lastName: { contains: search, mode: 'insensitive' as const } },
          { username: { contains: search, mode: 'insensitive' as const } },
        ],
      }),
    };

    const [data, total] = await Promise.all([
      this.prisma.staff.findMany({
        where,
        select: SAFE_STAFF_SELECT,
        orderBy: { id: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.staff.count({ where }),
    ]);

    return { data, total };
  }

  async get(id: number): Promise<SafeStaff & { staffGroup: StaffGroup }> {
    const staff = await this.prisma.staff.findUnique({
      where: { id },
      select: { ...SAFE_STAFF_SELECT, staffGroup: true },
    });
    if (!staff) throw new NotFoundException(`Staff ${id} not found`);
    return staff;
  }

  async create(dto: CreateStaffDto): Promise<SafeStaff> {
    // Check uniqueness
    const exists = await this.prisma.staff.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (exists) throw new ConflictException('Email or username already in use');

    await this.getGroup(dto.staffGroupId); // validate group exists

    const { password, departmentIds, ...rest } = dto;
    const passwordHash = await hashPassword(password);

    return this.prisma.staff.create({
      data: {
        ...rest,
        passwordHash,
        departments: departmentIds.length
          ? {
              create: departmentIds.map((departmentId) => ({ departmentId })),
            }
          : undefined,
      },
      select: SAFE_STAFF_SELECT,
    });
  }

  async update(id: number, dto: UpdateStaffDto): Promise<SafeStaff> {
    await this.get(id); // validate exists

    const { password, departmentIds, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };

    if (password) {
      data['passwordHash'] = await hashPassword(password);
    }

    if (departmentIds !== undefined) {
      // Replace department assignments atomically
      await this.prisma.departmentStaff.deleteMany({ where: { staffId: id } });
      if (departmentIds.length) {
        await this.prisma.departmentStaff.createMany({
          data: departmentIds.map((departmentId) => ({ staffId: id, departmentId })),
        });
      }
    }

    return this.prisma.staff.update({
      where: { id },
      data,
      select: SAFE_STAFF_SELECT,
    });
  }

  /** Soft-disable a staff member rather than deleting. */
  async disable(id: number): Promise<SafeStaff> {
    await this.get(id);
    return this.prisma.staff.update({
      where: { id },
      data: { isEnabled: false },
      select: SAFE_STAFF_SELECT,
    });
  }
}
