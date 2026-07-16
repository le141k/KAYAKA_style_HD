import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { hashPassword } from '../../auth/password.util';
import { SessionRevocationService } from '../../auth/session-revocation.service';
import type { AuthStaff } from '../../auth/auth.decorators';
import { RbacAuditService } from './rbac-audit.service';
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

type SafeStaffWithGroup = SafeStaff & { staffGroup: StaffGroup };

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
  constructor(
    private readonly prisma: PrismaService,
    // Optional so the existing unit tests can construct the service with just a
    // Prisma mock; in the running app DI always provides both (AuthModule is
    // @Global and exports SessionRevocationService; RbacAuditService is local).
    @Optional() private readonly sessions?: SessionRevocationService,
    @Optional() private readonly audit?: RbacAuditService,
  ) {}

  // ─────────────────── Staff Groups ───────────────────

  async listGroups(): Promise<StaffGroup[]> {
    return this.prisma.staffGroup.findMany({ orderBy: { id: 'asc' } });
  }

  async getGroup(id: number): Promise<StaffGroup> {
    const group = await this.prisma.staffGroup.findUnique({ where: { id } });
    if (!group) throw new NotFoundException(`StaffGroup ${id} not found`);
    return group;
  }

  async createGroup(dto: CreateStaffGroupDto, actor?: AuthStaff): Promise<StaffGroup> {
    const group = await this.prisma.staffGroup.create({ data: dto });
    await this.audit?.log({
      actor,
      action: 'group.create',
      targetType: 'group',
      targetId: group.id,
      targetLabel: group.title,
      metadata: { isAdmin: group.isAdmin, permissions: group.permissions },
    });
    return group;
  }

  async updateGroup(id: number, dto: UpdateStaffGroupDto, actor?: AuthStaff): Promise<StaffGroup> {
    const before = await this.getGroup(id);
    const updated = await this.prisma.staffGroup.update({ where: { id }, data: dto });

    // A permission change alters what every member of the group may do — revoke
    // their sessions so stale permission claims in existing tokens can't linger.
    const permissionsChanged =
      dto.permissions !== undefined && !sameStringSet(before.permissions, updated.permissions);

    if (permissionsChanged) {
      await this.sessions?.revokeAllForGroup(id);
      await this.audit?.log({
        actor,
        action: 'group.permissions_change',
        targetType: 'group',
        targetId: id,
        targetLabel: updated.title,
        metadata: { before: before.permissions, after: updated.permissions },
      });
    } else {
      await this.audit?.log({
        actor,
        action: 'group.update',
        targetType: 'group',
        targetId: id,
        targetLabel: updated.title,
        metadata: diffFields(before, updated, ['title']),
      });
    }
    return updated;
  }

  /**
   * Delete a staff group.
   * Guards:
   *  - 404 if the group does not exist.
   *  - 403 if it is the last remaining administrator group (protect RBAC).
   *  - 409 if any staff members are still assigned (UI shows a clear message).
   */
  async deleteGroup(id: number, actor?: AuthStaff): Promise<void> {
    const group = await this.getGroup(id); // 404 if not found

    if (group.isAdmin) {
      const adminGroupCount = await this.prisma.staffGroup.count({ where: { isAdmin: true } });
      if (adminGroupCount <= 1) {
        throw new ForbiddenException('Cannot delete the last administrator group');
      }
    }

    const memberCount = await this.prisma.staff.count({ where: { staffGroupId: id } });
    if (memberCount > 0) {
      throw new ConflictException(
        `Cannot delete: ${memberCount} staff member${memberCount === 1 ? ' is' : 's are'} still assigned to this group`,
      );
    }
    await this.prisma.staffGroup.delete({ where: { id } });
    await this.audit?.log({
      actor,
      action: 'group.delete',
      targetType: 'group',
      targetId: id,
      targetLabel: group.title,
    });
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

  async get(id: number): Promise<SafeStaffWithGroup> {
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
  private async assertCanAssignGroup(groupId: number, actor?: AuthStaff): Promise<StaffGroup> {
    const group = await this.getGroup(groupId); // validate exists (404 if not)
    if (group.isAdmin && actor && !actor.isAdmin) {
      throw new ForbiddenException('Only an administrator may assign a staff member to an admin group');
    }
    return group;
  }

  /** Count staff members who are both enabled AND in an admin group. */
  private countEnabledAdmins(): Promise<number> {
    return this.prisma.staff.count({ where: { isEnabled: true, staffGroup: { isAdmin: true } } });
  }

  /**
   * Block a change that would remove the last active administrator — either by
   * disabling them or by moving them out of every admin group. `targetGroup` is
   * the group the member is being moved into (undefined = group unchanged).
   */
  private async assertNotRemovingLastAdmin(
    before: SafeStaffWithGroup,
    opts: { disabling?: boolean; targetGroup?: StaffGroup },
  ): Promise<void> {
    const wasEnabledAdmin = before.isEnabled && before.staffGroup.isAdmin;
    if (!wasEnabledAdmin) return;

    const stillEnabled = opts.disabling ? false : true;
    const stillAdmin = opts.targetGroup ? opts.targetGroup.isAdmin : before.staffGroup.isAdmin;
    if (stillEnabled && stillAdmin) return; // change keeps them an active admin

    const enabledAdmins = await this.countEnabledAdmins();
    if (enabledAdmins <= 1) {
      throw new ForbiddenException('Cannot disable or demote the last active administrator');
    }
  }

  async create(dto: CreateStaffDto, actor?: AuthStaff): Promise<SafeStaff> {
    // Check uniqueness
    const exists = await this.prisma.staff.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (exists) throw new ConflictException('Email or username already in use');

    const group = await this.assertCanAssignGroup(dto.staffGroupId, actor); // validate + escalation guard

    const { password, departmentIds, ...rest } = dto;
    const passwordHash = await hashPassword(password);

    const staff = await this.prisma.staff.create({
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

    await this.audit?.log({
      actor,
      action: 'staff.create',
      targetType: 'staff',
      targetId: staff.id,
      targetLabel: staff.email,
      metadata: { staffGroupId: staff.staffGroupId, groupTitle: group.title, isAdmin: group.isAdmin },
    });

    return staff;
  }

  async update(id: number, dto: UpdateStaffDto, actor?: AuthStaff): Promise<SafeStaff> {
    const before = await this.get(id); // validate exists (+ current group)

    // Validate the target group exists and block non-admins from promoting a
    // staff member into an admin group (privilege-escalation guard).
    let targetGroup: StaffGroup | undefined;
    if (dto.staffGroupId !== undefined) {
      targetGroup = await this.assertCanAssignGroup(dto.staffGroupId, actor);
    }

    const roleChanged = dto.staffGroupId !== undefined && dto.staffGroupId !== before.staffGroupId;
    const passwordChanged = !!dto.password;
    const enabledChanged = dto.isEnabled !== undefined && dto.isEnabled !== before.isEnabled;
    const disabling = enabledChanged && dto.isEnabled === false;

    // Never strand the deployment without an administrator.
    if (disabling || (roleChanged && targetGroup)) {
      await this.assertNotRemovingLastAdmin(before, { disabling, targetGroup });
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

    const updated = await this.prisma.staff.update({
      where: { id },
      data,
      select: SAFE_STAFF_SELECT,
    });

    // Any access-affecting change invalidates existing sessions (role swap,
    // admin password reset, or disable). Re-enabling does NOT revoke.
    if (roleChanged || passwordChanged || disabling) {
      await this.sessions?.revokeAllForStaff(id);
    }

    await this.auditStaffUpdate({ actor, before, updated, roleChanged, passwordChanged, enabledChanged });

    return updated;
  }

  /** Soft-disable a staff member rather than deleting. */
  async disable(id: number, actor?: AuthStaff): Promise<SafeStaff> {
    const before = await this.get(id);
    await this.assertNotRemovingLastAdmin(before, { disabling: true });

    const updated = await this.prisma.staff.update({
      where: { id },
      data: { isEnabled: false },
      select: SAFE_STAFF_SELECT,
    });

    // Only revoke if this actually transitioned enabled → disabled.
    if (before.isEnabled) {
      await this.sessions?.revokeAllForStaff(id);
    }

    await this.audit?.log({
      actor,
      action: 'staff.disable',
      targetType: 'staff',
      targetId: id,
      targetLabel: updated.email,
    });

    return updated;
  }

  /** Emit the appropriate audit entries for an update (role/password/enabled/other). */
  private async auditStaffUpdate(params: {
    actor?: AuthStaff;
    before: SafeStaffWithGroup;
    updated: SafeStaff;
    roleChanged: boolean;
    passwordChanged: boolean;
    enabledChanged: boolean;
  }): Promise<void> {
    if (!this.audit) return;
    const { actor, before, updated, roleChanged, passwordChanged, enabledChanged } = params;
    const base = { actor, targetType: 'staff' as const, targetId: updated.id, targetLabel: updated.email };

    if (roleChanged) {
      await this.audit.log({
        ...base,
        action: 'staff.role_change',
        metadata: { fromGroupId: before.staffGroupId, toGroupId: updated.staffGroupId },
      });
    }
    if (passwordChanged) {
      await this.audit.log({ ...base, action: 'staff.password_reset' });
    }
    if (enabledChanged) {
      await this.audit.log({ ...base, action: updated.isEnabled ? 'staff.enable' : 'staff.disable' });
    }
    if (!roleChanged && !passwordChanged && !enabledChanged) {
      await this.audit.log({
        ...base,
        action: 'staff.update',
        metadata: diffFields(before, updated, [
          'email',
          'username',
          'firstName',
          'lastName',
          'designation',
          'mobileNumber',
          'timezone',
        ]),
      });
    }
  }
}

/** Shallow equality of two string arrays treated as sets (order-independent). */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((x) => setB.has(x));
}

/** Small before/after diff for audit metadata over a whitelist of keys. */
function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: (keyof T)[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (before[k] !== after[k]) out[String(k)] = { from: before[k], to: after[k] };
  }
  return out;
}
