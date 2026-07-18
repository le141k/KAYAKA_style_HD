import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { promises as fs } from 'node:fs';
import { APP_CONFIG, AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

const MIB = 1024 * 1024;
const ORPHAN_CAPACITY_LOCK_NAMESPACE = 230723;
const ORPHAN_CAPACITY_LOCK_ID = 1;

type CapacitySnapshot = {
  _count: { _all: number };
  _sum: { size: number | null };
};

type CapacityClient = {
  attachment: unknown;
};

/**
 * Cross-channel attachment capacity gate.
 *
 * The cheap preflight check rejects an HTTP request before Multer writes it.
 * The transaction-scoped check serializes every orphan adoption across API
 * replicas, making the configured outstanding row/byte caps authoritative.
 */
@Injectable()
export class AttachmentCapacityService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Best-effort early admission check; the transaction boundary below is authoritative. */
  async assertCanAccept(bytes: number, count: number, bytesNotYetOnDisk = bytes): Promise<void> {
    this.assertRequest(bytes, count);
    if (!Number.isSafeInteger(bytesNotYetOnDisk) || bytesNotYetOnDisk < 0 || bytesNotYetOnDisk > bytes) {
      throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
    }
    await this.assertDiskSpace(bytesNotYetOnDisk);
    const snapshot = await this.readSnapshot(this.prisma);
    this.assertOrphanCapacity(snapshot, bytes, count);
  }

  /** Filesystem-only gate for uploads that are born already linked to a ticket. */
  async assertDiskSpace(bytes: number): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
    }
    await this.assertFreeDisk(bytes);
  }

  /**
   * Run the permanent-storage + DB-row step under a global transaction advisory
   * lock. This closes the aggregate-check race between concurrent API replicas.
   * The bytes already live in quarantine on the same upload filesystem, so the
   * authoritative disk check verifies the reserve itself instead of subtracting
   * the payload a second time.
   */
  async withOrphanCapacity<T>(
    bytes: number,
    count: number,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    this.assertRequest(bytes, count);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(${ORPHAN_CAPACITY_LOCK_NAMESPACE}, ${ORPHAN_CAPACITY_LOCK_ID})`,
        );
        await this.assertFreeDisk(0);
        const snapshot = await this.readSnapshot(tx);
        this.assertOrphanCapacity(snapshot, bytes, count);
        return operation(tx);
      },
      { maxWait: 15_000, timeout: 120_000 },
    );
  }

  private assertRequest(bytes: number, count: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(count) || count < 1) {
      throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
    }
  }

  private async assertFreeDisk(incomingBytes: number): Promise<void> {
    try {
      await fs.mkdir(this.config.TELECOM_HD_UPLOAD_DIR, { recursive: true, mode: 0o700 });
      const stat = await fs.statfs(this.config.TELECOM_HD_UPLOAD_DIR, { bigint: true });
      const availableBytes = stat.bavail * stat.bsize;
      const reserveBytes = BigInt(this.config.TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB) * BigInt(MIB);
      if (availableBytes - BigInt(incomingBytes) < reserveBytes) {
        throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
      }
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
    }
  }

  private async readSnapshot(client: CapacityClient): Promise<CapacitySnapshot> {
    const delegate = client.attachment as {
      aggregate(args: {
        where: { ticketId: null; postId: null; noteId: null };
        _count: { _all: true };
        _sum: { size: true };
      }): Promise<CapacitySnapshot>;
    };
    try {
      return await delegate.aggregate({
        where: { ticketId: null, postId: null, noteId: null },
        _count: { _all: true },
        _sum: { size: true },
      });
    } catch {
      throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
    }
  }

  private assertOrphanCapacity(
    snapshot: CapacitySnapshot,
    incomingBytes: number,
    incomingCount: number,
  ): void {
    const maxBytes = this.config.TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB * MIB;
    const currentBytes = snapshot._sum.size ?? 0;
    if (
      snapshot._count._all + incomingCount > this.config.TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT ||
      currentBytes + incomingBytes > maxBytes
    ) {
      throw new ServiceUnavailableException('Attachment storage is temporarily unavailable');
    }
  }
}
