import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../../config/configuration';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService, type StagedAttachmentDeletion } from './storage.service';

const CLEANUP_INTERVAL_MS = 5 * 60_000;
const MAX_BATCH = 250;

/** Deletes unclaimed attachment rows + bytes after the configured TTL, with row-lock race safety. */
@Injectable()
export class OrphanCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrphanCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV === 'test') return;
    const run = () => {
      if (this.running) {
        this.logger.warn('Attachment cleanup skipped because the previous run is still active');
        return;
      }
      this.running = true;
      void this.cleanup()
        .catch(() => this.logger.error('Orphan cleanup run failed'))
        .finally(() => {
          this.running = false;
        });
    };
    run();
    this.timer = setInterval(run, CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanup(): Promise<{ rows: number; bytes: number }> {
    const cutoff = new Date(Date.now() - this.config.TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS * 60 * 60_000);
    const maxItems = this.config.TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS;
    const deadline = Date.now() + this.config.TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS * 1000;
    const stagedRecovery = await this.recoverStagedDeletes(maxItems, deadline);
    const temporary =
      Date.now() < deadline
        ? await this.storage.cleanupStaleQuarantine(cutoff, maxItems, deadline)
        : { files: 0, bytes: 0 };
    let rows = 0;
    let bytes = 0;
    let examined = 0;
    let pendingFiles = stagedRecovery.failed;

    // Drain in repeated batches instead of stopping after the first page. Every
    // phase has an explicit item ceiling and all phases share one wall-clock limit.
    while (examined < maxItems && Date.now() < deadline) {
      const take = Math.min(MAX_BATCH, maxItems - examined);
      const candidates = await this.prisma.attachment.findMany({
        where: { ticketId: null, postId: null, noteId: null, createdAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take,
      });
      if (candidates.length === 0) break;

      for (const candidate of candidates) {
        if (examined >= maxItems || Date.now() >= deadline) break;
        examined += 1;
        const stagedRef: {
          value?: { staged: StagedAttachmentDeletion; originalKey: string };
        } = {};
        let removed: { size: number; staged: StagedAttachmentDeletion | null } | null;
        try {
          removed = await this.prisma.$transaction(
            async (tx) => {
              await tx.$queryRaw(
                Prisma.sql`SELECT "id" FROM "Attachment" WHERE "id" = ${candidate.id} FOR UPDATE`,
              );
              const current = await tx.attachment.findFirst({
                where: {
                  id: candidate.id,
                  ticketId: null,
                  postId: null,
                  noteId: null,
                  createdAt: { lt: cutoff },
                },
              });
              if (!current) return null;
              const staged = await this.storage.stageDelete(current.storageKey, current.id);
              if (staged) stagedRef.value = { staged, originalKey: current.storageKey };
              await tx.attachment.delete({ where: { id: current.id } });
              return { size: current.size, staged };
            },
            { timeout: 15_000 },
          );
        } catch (error) {
          if (stagedRef.value) {
            await this.storage
              .restoreStagedDelete(stagedRef.value.staged.storageKey, stagedRef.value.originalKey)
              .catch(() => undefined);
          }
          throw error;
        }
        if (removed) {
          rows += 1;
          if (removed.staged) {
            try {
              await this.storage.finalizeStagedDelete(removed.staged.storageKey);
              bytes += removed.size;
            } catch {
              pendingFiles += 1;
            }
          }
        }
      }
      if (candidates.length < take) break;
    }

    if (rows > 0 || temporary.files > 0 || stagedRecovery.finalized > 0) {
      this.logger.log(
        `Attachment cleanup: rows=${rows}, bytes=${bytes}, tempFiles=${temporary.files}, ` +
          `tempBytes=${temporary.bytes}, ` +
          `recovered=${stagedRecovery.restored + stagedRecovery.finalized}, pending=${pendingFiles}`,
      );
    }
    if (pendingFiles > 0) this.logger.error(`Attachment cleanup has ${pendingFiles} pending file(s)`);
    if (examined >= maxItems || Date.now() >= deadline) {
      this.logger.warn(`Attachment cleanup reached its bounded run limit after ${examined} candidate(s)`);
    }
    return { rows, bytes };
  }

  private async recoverStagedDeletes(
    limit: number,
    deadline: number,
  ): Promise<{ restored: number; finalized: number; failed: number }> {
    const staged = await this.storage.listStagedDeletes(limit);
    const result = { restored: 0, finalized: 0, failed: 0 };
    for (const item of staged) {
      if (Date.now() >= deadline) break;
      try {
        const row = await this.prisma.attachment.findUnique({
          where: { id: item.attachmentId },
          select: { storageKey: true },
        });
        if (row) {
          await this.storage.restoreStagedDelete(item.storageKey, row.storageKey);
          result.restored += 1;
        } else {
          await this.storage.finalizeStagedDelete(item.storageKey);
          result.finalized += 1;
        }
      } catch {
        result.failed += 1;
      }
    }
    return result;
  }
}
