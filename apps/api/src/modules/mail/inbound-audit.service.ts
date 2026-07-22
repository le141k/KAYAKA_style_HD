import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** One of the audited inbound operator actions. */
export type InboundAuditAction =
  | 'mail.reconcile'
  | 'mail.reconcile_requested'
  | 'mail.reconcile_completed'
  | 'mail.reconcile_failed'
  | 'mail.transport_collision'
  | 'mail.quarantine_replay';

export interface InboundAuditEntry {
  actorStaffId?: number | null;
  actorEmail?: string;
  action: InboundAuditAction;
  queueId?: number | null;
  deliveryId?: number | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only writer for the inbound operator-action audit trail (see `InboundAuditLog`).
 *
 * Kept separate from RbacAuditLog (staff/group RBAC) so mail-ops history is queryable on its
 * own with the queue/delivery it targeted. Writes through this convenience service are
 * best-effort (e.g. replay); correctness-critical reconcile/collision transitions write their
 * audit row directly through the same Prisma transaction as the state CAS.
 */
@Injectable()
export class InboundAuditService {
  private readonly logger = new Logger(InboundAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: InboundAuditEntry): Promise<void> {
    try {
      await this.prisma.inboundAuditLog.create({
        data: {
          actorStaffId: entry.actorStaffId ?? null,
          actorEmail: entry.actorEmail ?? '',
          action: entry.action,
          queueId: entry.queueId ?? null,
          deliveryId: entry.deliveryId ?? null,
          reason: entry.reason ?? null,
          metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write inbound audit (${entry.action} queue=${entry.queueId ?? '-'} ` +
          `delivery=${entry.deliveryId ?? '-'}): ${String(err)}`,
      );
    }
  }

  /** List recent inbound audit entries (admin observability). */
  list(params: { page: number; limit: number }) {
    const { page, limit } = params;
    return this.prisma.$transaction([
      this.prisma.inboundAuditLog.findMany({
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inboundAuditLog.count(),
    ]);
  }
}
