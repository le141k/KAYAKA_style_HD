import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptField } from '../../common/field-encrypt.util';
import type { CreateEmailQueueDto, UpdateEmailQueueDto } from './dto';

/** Fields that are always omitted from responses (stored password). */
const SAFE_SELECT = {
  id: true,
  type: true,
  emailAddress: true,
  host: true,
  port: true,
  username: true,
  useTls: true,
  departmentId: true,
  signature: true,
  isEnabled: true,
  createdAt: true,
  // Inbound sync health (operator visibility).
  syncState: true,
  lastError: true,
  lastSeenUid: true,
  uidValidity: true,
  cursorGeneration: true,
} as const;

@Injectable()
export class EmailQueueService {
  constructor(private readonly prisma: PrismaService) {}

  /** List all email queues (passwordEnc excluded). */
  list() {
    return this.prisma.emailQueue.findMany({
      select: SAFE_SELECT,
      orderBy: { id: 'asc' },
    });
  }

  /** Get a single email queue by ID (passwordEnc excluded). */
  async get(id: number) {
    const queue = await this.prisma.emailQueue.findUnique({
      where: { id },
      select: SAFE_SELECT,
    });
    if (!queue) throw new NotFoundException(`EmailQueue #${id} not found`);
    return queue;
  }

  /** Create a new email queue. The caller-supplied password is encrypted at rest. */
  create(dto: CreateEmailQueueDto) {
    const { password, ...rest } = dto;
    const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
    return this.prisma.emailQueue.create({
      data: {
        ...rest,
        passwordEnc: encryptField(password ?? '', encKey),
      },
      select: SAFE_SELECT,
    });
  }

  /** Update an existing email queue (partial). Password is encrypted at rest if provided. */
  async update(id: number, dto: UpdateEmailQueueDto) {
    await this.get(id); // throws NotFoundException when missing
    const { password, ...rest } = dto;
    const data: Record<string, unknown> = { ...rest };
    if (password !== undefined) {
      const encKey = process.env['TELECOM_HD_FIELD_ENCRYPTION_KEY'];
      data.passwordEnc = encryptField(password, encKey);
    }
    return this.prisma.emailQueue.update({
      where: { id },
      data,
      select: SAFE_SELECT,
    });
  }

  /** Delete an email queue. */
  async delete(id: number): Promise<void> {
    await this.get(id); // throws NotFoundException when missing
    await this.prisma.emailQueue.delete({ where: { id } });
  }

  /**
   * Reconcile a halted (NEEDS_RECONCILIATION) or paused IMAP queue: clears the sync
   * state, bumps `cursorGeneration` (invalidating any in-flight stale poller's CAS) and
   * resets `uidValidity` to NULL so the next poll re-bootstraps under the configured
   * FROM_NOW / BACKFILL policy. The operator's explicit action to resume intake.
   */
  async reconcile(id: number) {
    await this.get(id); // 404 when missing
    return this.prisma.emailQueue.update({
      where: { id },
      data: {
        syncState: 'OK',
        lastError: null,
        uidValidity: null,
        lastSeenUid: 0,
        cursorGeneration: { increment: 1 },
      },
      select: SAFE_SELECT,
    });
  }

  /** List quarantined inbound deliveries (metadata only — never the raw MIME blob). */
  listQuarantined() {
    return this.prisma.inboundDelivery.findMany({
      where: { state: 'QUARANTINED' },
      orderBy: { id: 'desc' },
      take: 200,
      select: {
        id: true,
        transport: true,
        queueId: true,
        messageId: true,
        envelopeFrom: true,
        envelopeTo: true,
        subject: true,
        sizeBytes: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  /**
   * Replay a quarantined delivery: reset it to ACCEPTED (attempts 0, lease cleared) so
   * the drain reprocesses it. The raw MIME was retained, so nothing was lost.
   */
  async replayQuarantined(deliveryId: number) {
    const reset = await this.prisma.inboundDelivery.updateMany({
      where: { id: deliveryId, state: 'QUARANTINED' },
      data: { state: 'ACCEPTED', attempts: 0, nextAttemptAt: null, leaseOwner: null, leaseExpiresAt: null },
    });
    if (reset.count === 0) {
      throw new NotFoundException(`Quarantined delivery #${deliveryId} not found`);
    }
    return { replayed: true };
  }
}
