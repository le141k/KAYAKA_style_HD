import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { hashPassword } from '../../auth/password.util';
import type { AuthStaff } from '../../auth/auth.decorators';
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

  /**
   * Privilege guard for group create/update: a non-admin actor may neither create
   * an admin group nor grant any permission they don't already hold (escalation).
   * Admins (or no actor = seed/internal) are unrestricted.
   */
  private assertGroupPrivilege(
    isAdmin: boolean | undefined,
    permissions: string[] | undefined,
    actor?: AuthStaff,
  ) {
    if (!actor || actor.isAdmin) return;
    if (isAdmin) {
      throw new ForbiddenException('Only an administrator may create an admin group');
    }
    if (permissions && permissions.length) {
      const held = new Set<string>(actor.permissions);
      const escalated = permissions.filter((p) => !held.has(p));
      if (escalated.length) {
        throw new ForbiddenException(`Cannot grant permissions you do not hold: ${escalated.join(', ')}`);
      }
    }
  }

  async createGroup(dto: CreateStaffGroupDto, actor?: AuthStaff): Promise<StaffGroup> {
    this.assertGroupPrivilege(dto.isAdmin, dto.permissions, actor);
    return this.prisma.staffGroup.create({ data: dto });
  }

  async updateGroup(id: number, dto: UpdateStaffGroupDto, actor?: AuthStaff): Promise<StaffGroup> {
    await this.getGroup(id);
    this.assertGroupPrivilege(false, dto.permissions, actor);
    return this.prisma.staffGroup.update({ where: { id }, data: dto });
  }

  /**
   * Delete a staff group.
   * Guards: refuses if any staff members are still assigned to the group
   * (returning 409 ConflictException so the UI can show a clear message).
   */
  async deleteGroup(id: number): Promise<void> {
    await this.getGroup(id); // 404 if not found
    const memberCount = await this.prisma.staff.count({ where: { staffGroupId: id } });
    if (memberCount > 0) {
      throw new ConflictException(
        `Cannot delete: ${memberCount} staff member${memberCount === 1 ? ' is' : 's are'} still assigned to this group`,
      );
    }
    await this.prisma.staffGroup.delete({ where: { id } });
  }

  // ─────────────────── Staff Members ───────────────────

  /** Minimal staff directory for assignee pickers (no sensitive fields). */
  listAssignable() {
    return this.prisma.staff.findMany({
      where: { isEnabled: true },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
    });
  }

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

  /**
   * Guard against privilege escalation: only an admin actor may place a staff
   * member into a group flagged `isAdmin`. Also validates the group exists
   * (returns 404 instead of a raw FK 500). Pass `actor` from the request.
   */
  private async assertCanAssignGroup(groupId: number, actor?: AuthStaff): Promise<void> {
    const group = await this.getGroup(groupId); // validate exists (404 if not)
    if (group.isAdmin && actor && !actor.isAdmin) {
      throw new ForbiddenException('Only an administrator may assign a staff member to an admin group');
    }
  }

  async create(dto: CreateStaffDto, actor?: AuthStaff): Promise<SafeStaff> {
    // Check uniqueness
    const exists = await this.prisma.staff.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (exists) throw new ConflictException('Email or username already in use');

    await this.assertCanAssignGroup(dto.staffGroupId, actor); // validate + escalation guard

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

  /**
   * Refuse an operation that would leave zero enabled administrators (lockout).
   * No-op unless the target is currently an enabled admin and is the only one.
   */
  private async assertNotLastAdmin(staffId: number): Promise<void> {
    const target = await this.prisma.staff.findUnique({
      where: { id: staffId },
      select: { isEnabled: true, staffGroup: { select: { isAdmin: true } } },
    });
    if (!target?.isEnabled || !target.staffGroup?.isAdmin) return; // not an enabled admin
    const enabledAdmins = await this.prisma.staff.count({
      where: { isEnabled: true, staffGroup: { isAdmin: true } },
    });
    if (enabledAdmins <= 1) {
      throw new ForbiddenException('Cannot disable or de-admin the last enabled administrator');
    }
  }

  async update(id: number, dto: UpdateStaffDto, actor?: AuthStaff): Promise<SafeStaff> {
    await this.get(id); // validate exists

    // Validate the target group exists and block non-admins from promoting a
    // staff member into an admin group (privilege-escalation guard).
    if (dto.staffGroupId !== undefined) {
      await this.assertCanAssignGroup(dto.staffGroupId, actor);
    }

    // Last-admin lockout guard: disabling, or moving the sole admin into a
    // non-admin group, would lock everyone out.
    if (dto.isEnabled === false) {
      await this.assertNotLastAdmin(id);
    } else if (dto.staffGroupId !== undefined) {
      const newGroup = await this.prisma.staffGroup.findUnique({
        where: { id: dto.staffGroupId },
        select: { isAdmin: true },
      });
      if (!newGroup?.isAdmin) await this.assertNotLastAdmin(id);
    }

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
    await this.assertNotLastAdmin(id); // never lock out the last admin
    return this.prisma.staff.update({
      where: { id },
      data: { isEnabled: false },
      select: SAFE_STAFF_SELECT,
    });
  }
}
