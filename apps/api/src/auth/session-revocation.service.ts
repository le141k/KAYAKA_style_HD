import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AppConfig, APP_CONFIG } from '../config/configuration';
import { TokenBlocklistService } from './token-blocklist.service';

/**
 * Central "log this staff member out everywhere" primitive, used when their
 * access changes (role/group swap, password reset by an admin, or account
 * disable) so a stale session can't keep acting with the old rights.
 *
 * Two layers, matching the two token types:
 *  1. Refresh tokens — marked `revokedAt` in Postgres, so no new access token can
 *     be minted. This is durable and the primary guarantee.
 *  2. Access tokens — a per-staff Redis cutoff (see TokenBlocklistService) so the
 *     already-issued ~15-min access token is rejected immediately rather than
 *     lingering until it expires. Best-effort / fail-open (Redis).
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly blocklist?: TokenBlocklistService,
  ) {}

  /** Revoke every active session (refresh + access) for a single staff member. */
  async revokeAllForStaff(staffId: number): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { staffId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    // Blocker #7: a security change (admin password reset, disable, logout-all) must also
    // burn any still-pending password-reset link, so a previously-issued link can't be used
    // to re-set the password after the change.
    await this.prisma.passwordReset.updateMany({
      where: { staffId, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (this.blocklist) {
      await this.blocklist.revokeStaffAccessBefore(staffId, this.config.TELECOM_HD_JWT_ACCESS_TTL);
    }
    this.logger.log(`Sessions revoked for staff ${staffId}`);
  }

  /**
   * Revoke sessions for every staff member in a group — used when the group's
   * permission set changes, so all its members re-authenticate under the new
   * rights instead of carrying stale permission claims in their tokens.
   */
  async revokeAllForGroup(groupId: number): Promise<void> {
    const members = await this.prisma.staff.findMany({
      where: { staffGroupId: groupId },
      select: { id: true },
    });
    if (members.length === 0) return;

    const ids = members.map((m) => m.id);
    await this.prisma.refreshToken.updateMany({
      where: { staffId: { in: ids }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (this.blocklist) {
      await Promise.all(
        ids.map((id) => this.blocklist!.revokeStaffAccessBefore(id, this.config.TELECOM_HD_JWT_ACCESS_TTL)),
      );
    }
    this.logger.log(`Sessions revoked for ${ids.length} member(s) of group ${groupId}`);
  }
}
