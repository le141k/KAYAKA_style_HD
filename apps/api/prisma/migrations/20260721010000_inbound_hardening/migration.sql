-- Inbound hardening: operator liveness timestamps, truncated-raw flag, raw-MIME retention
-- marker, a durable inbound audit trail, and the disabled-IMAP-queue cutover halt.

-- Operator liveness signal (advisory; not part of any CAS). Populated by the poller/supervisor.
ALTER TABLE "EmailQueue" ADD COLUMN "lastConnectedAt" TIMESTAMP(3);
ALTER TABLE "EmailQueue" ADD COLUMN "lastPollAt" TIMESTAMP(3);
ALTER TABLE "EmailQueue" ADD COLUMN "lastAcceptedAt" TIMESTAMP(3);

-- Oversized IMAP messages are fetched capped at the size limit + 1 byte; flag the retained
-- raw MIME as truncated (a faithful replay must re-fetch the original from the mailbox).
ALTER TABLE "InboundDelivery" ADD COLUMN "truncated" BOOLEAN NOT NULL DEFAULT false;
-- Retention marker: set when a terminal (PROCESSED/SKIPPED) delivery's raw MIME is pruned.
ALTER TABLE "InboundDelivery" ADD COLUMN "rawPrunedAt" TIMESTAMP(3);

-- Durable audit of inbound operator actions (reconcile / quarantine replay) with actor + reason.
CREATE TABLE "InboundAuditLog" (
    "id" SERIAL NOT NULL,
    "actorStaffId" INTEGER,
    "actorEmail" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "queueId" INTEGER,
    "deliveryId" INTEGER,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundAuditLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "InboundAuditLog_createdAt_idx" ON "InboundAuditLog"("createdAt");
CREATE INDEX "InboundAuditLog_queueId_idx" ON "InboundAuditLog"("queueId");

-- C5 cutover: also halt DISABLED legacy IMAP queues that exist at upgrade time. The prior
-- ledger migration halted only ENABLED IMAP queues; a disabled one, if later re-enabled,
-- would auto-bootstrap FROM_NOW over its legacy Setting cursor and silently skip mail.
-- Force it through the same explicit, audited reconcile. (Queues created AFTER the upgrade
-- start OK and bootstrap normally — they have no legacy cursor to skip.)
UPDATE "EmailQueue"
SET "syncState" = 'NEEDS_RECONCILIATION',
    "lastError" = 'Upgraded to InboundDelivery ledger; run reconcile (RESUME_MIGRATED / FROM_NOW / bounded BACKFILL) before re-enabling'
WHERE "type" = 'IMAP' AND "isEnabled" = false AND "syncState" = 'OK';
