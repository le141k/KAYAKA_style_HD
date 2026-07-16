import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, RbacAuditLog } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthStaff } from '../../auth/auth.decorators';

export type RbacTargetType = 'staff' | 'group';

/** One of the audited RBAC actions (kept as a string union for readability). */
export type RbacAction =
  | 'staff.create'
  | 'staff.update'
  | 'staff.role_change'
  | 'staff.password_reset'
  | 'staff.enable'
  | 'staff.disable'
  | 'group.create'
  | 'group.update'
  | 'group.permissions_change'
  | 'group.delete';

export interface RbacAuditEntry {
  actor?: Pick<AuthStaff, 'staffId' | 'email'>;
  action: RbacAction;
  targetType: RbacTargetType;
  targetId?: number | null;
  targetLabel?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only writer/reader for the RBAC audit trail (see `RbacAuditLog`).
 *
 * Writes are best-effort: an audit-insert failure is logged but never propagated,
 * so a transient DB hiccup on the audit row can't roll back the actual RBAC
 * change the operator requested. The primary change is the source of truth; the
 * log is a record of it.
 */
@Injectable()
export class RbacAuditService {
  private readonly logger = new Logger(RbacAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: RbacAuditEntry): Promise<void> {
    try {
      await this.prisma.rbacAuditLog.create({
        data: {
          actorStaffId: entry.actor?.staffId ?? null,
          actorEmail: entry.actor?.email ?? '',
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          targetLabel: entry.targetLabel ?? '',
          metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write RBAC audit entry (${entry.action} ${entry.targetType}#${entry.targetId ?? '?'}): ${String(err)}`,
      );
    }
  }

  async list(params: { page: number; limit: number }): Promise<{ data: RbacAuditLog[]; total: number }> {
    const { page, limit } = params;
    const [data, total] = await Promise.all([
      this.prisma.rbacAuditLog.findMany({
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.rbacAuditLog.count(),
    ]);
    return { data, total };
  }
}
