-- Inbound delivery ledger: durable record of every accepted inbound message so a
-- processing failure never loses mail and re-delivery is idempotent by transport key.

-- Enums
CREATE TYPE "InboundTransport" AS ENUM ('IMAP', 'PIPE');
CREATE TYPE "InboundDeliveryState" AS ENUM ('ACCEPTED', 'PROCESSING', 'PROCESSED', 'RETRY', 'QUARANTINED', 'SKIPPED');
CREATE TYPE "EmailQueueSyncState" AS ENUM ('OK', 'NEEDS_RECONCILIATION');

-- Per-queue durable IMAP cursor + sync health (replaces Setting `imap/lastSeenUid:<id>`).
ALTER TABLE "EmailQueue" ADD COLUMN "lastSeenUid" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EmailQueue" ADD COLUMN "uidValidity" BIGINT;
ALTER TABLE "EmailQueue" ADD COLUMN "syncState" "EmailQueueSyncState" NOT NULL DEFAULT 'OK';
ALTER TABLE "EmailQueue" ADD COLUMN "lastError" TEXT;

-- Ledger table
CREATE TABLE "InboundDelivery" (
    "id" SERIAL NOT NULL,
    "transport" "InboundTransport" NOT NULL,
    "queueId" INTEGER,
    "transportKey" TEXT NOT NULL,
    "uidValidity" BIGINT,
    "uid" INTEGER,
    "externalId" TEXT,
    "messageId" TEXT,
    "contentHash" TEXT NOT NULL,
    "envelopeFrom" TEXT,
    "envelopeTo" TEXT,
    "subject" TEXT NOT NULL DEFAULT '',
    "rawMime" BYTEA,
    "rawStorageKey" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "state" "InboundDeliveryState" NOT NULL DEFAULT 'ACCEPTED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "ticketId" INTEGER,
    "postId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "InboundDelivery_pkey" PRIMARY KEY ("id")
);

-- Unique transport key = the atomic idempotency claim.
CREATE UNIQUE INDEX "InboundDelivery_transportKey_key" ON "InboundDelivery"("transportKey");
CREATE INDEX "InboundDelivery_state_nextAttemptAt_idx" ON "InboundDelivery"("state", "nextAttemptAt");
CREATE INDEX "InboundDelivery_queueId_uidValidity_uid_idx" ON "InboundDelivery"("queueId", "uidValidity", "uid");
CREATE INDEX "InboundDelivery_messageId_idx" ON "InboundDelivery"("messageId");

ALTER TABLE "InboundDelivery"
    ADD CONSTRAINT "InboundDelivery_queueId_fkey"
    FOREIGN KEY ("queueId") REFERENCES "EmailQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
