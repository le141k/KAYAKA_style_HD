-- Inbound delivery ledger: durable record of every accepted inbound message so a
-- processing failure never loses mail and re-delivery is idempotent by transport key.

-- Enums
CREATE TYPE "InboundTransport" AS ENUM ('IMAP', 'PIPE');
CREATE TYPE "InboundDeliveryState" AS ENUM ('ACCEPTED', 'PROCESSING', 'PROCESSED', 'RETRY', 'QUARANTINED', 'SKIPPED');
CREATE TYPE "EmailQueueSyncState" AS ENUM ('OK', 'NEEDS_RECONCILIATION');

-- Per-queue durable IMAP cursor + sync health (replaces Setting `imap/lastSeenUid:<id>`).
ALTER TABLE "EmailQueue" ADD COLUMN "lastSeenUid" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "EmailQueue" ADD COLUMN "uidValidity" BIGINT;
ALTER TABLE "EmailQueue" ADD COLUMN "syncState" "EmailQueueSyncState" NOT NULL DEFAULT 'OK';
ALTER TABLE "EmailQueue" ADD COLUMN "lastError" TEXT;
ALTER TABLE "EmailQueue" ADD COLUMN "cursorGeneration" INTEGER NOT NULL DEFAULT 0;

-- Ledger table
CREATE TABLE "InboundDelivery" (
    "id" SERIAL NOT NULL,
    "transport" "InboundTransport" NOT NULL,
    "queueId" INTEGER,
    "transportKey" TEXT NOT NULL,
    "uidValidity" BIGINT,
    "uid" BIGINT,
    "externalId" TEXT,
    "messageId" TEXT,
    "contentHash" TEXT NOT NULL,
    "envelopeFrom" TEXT,
    "envelopeTo" TEXT,
    "subject" TEXT NOT NULL DEFAULT '',
    "departmentId" INTEGER,
    "rawMime" BYTEA,
    "rawStorageKey" TEXT,
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "state" "InboundDeliveryState" NOT NULL DEFAULT 'ACCEPTED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
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
-- Atomic logical-message claim: at most one delivery may own a given Message-ID
-- (race-safe dedup — replaces check-then-act). Plain UNIQUE on a nullable column —
-- Postgres treats NULLs as distinct, so unclaimed rows (NULL) don't collide. This
-- matches Prisma's `messageId String? @unique` so `migrate dev` won't drift.
CREATE UNIQUE INDEX "InboundDelivery_messageId_key" ON "InboundDelivery"("messageId");

ALTER TABLE "InboundDelivery"
    ADD CONSTRAINT "InboundDelivery_queueId_fkey"
    FOREIGN KEY ("queueId") REFERENCES "EmailQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Safe upgrade / cutover: any already-enabled IMAP queue is halted until an operator
-- explicitly reconciles (FROM_NOW or a bounded BACKFILL). This prevents the new
-- ledger from FROM_NOW-bootstrapping over an in-flight legacy cursor and silently
-- skipping mail that arrived during the deploy. The legacy Setting UID cursor
-- (`imap/lastSeenUid:<queueId>`) is copied into `lastSeenUid` as a resume hint.
UPDATE "EmailQueue" q
SET "lastSeenUid" = COALESCE(
      (
        SELECT (s."value")::text::bigint
        FROM "Setting" s
        WHERE s."section" = 'imap'
          AND s."key" = 'lastSeenUid:' || q."id"::text
          AND jsonb_typeof(s."value") = 'number'
      ),
      0
    ),
    "syncState" = 'NEEDS_RECONCILIATION',
    "lastError" = 'Upgraded to InboundDelivery ledger; reconcile (FROM_NOW or bounded BACKFILL) required'
WHERE q."isEnabled" = true AND q."type" = 'IMAP';
