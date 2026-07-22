-- P1-E logical inbound-message claims.
--
-- This is deliberately an expand-only migration. `InboundDelivery.messageId` remains
-- unique for the compatibility period because deployed workers still use it as a
-- post-creation idempotency backstop. New code writes the non-unique observed id and the
-- durable `InboundMessageClaim` instead. Dropping the legacy unique index is a separate
-- post-cutover migration after a real PostgreSQL backfill/rollback rehearsal. Deployment must
-- quiesce all old inbound workers; headerless old/new identity formats are intentionally not
-- mixed during this expand/contract transition.
--
-- pgcrypto is PostgreSQL contrib, used solely to backfill the bounded SHA-256 identity key
-- from existing Message-ID values. `IF NOT EXISTS` makes this a clear preflight failure on a
-- database role that cannot install approved extensions; PostgreSQL DDL is transactional, so
-- the migration does not leave a half-created logical-claim schema on failure.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Deterministic business routing: lower priority wins, queue id is the stable tie-breaker.
ALTER TABLE "EmailQueue"
  ADD COLUMN "routingPriority" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "EmailQueue"
  ADD CONSTRAINT "EmailQueue_routingPriority_range"
  CHECK ("routingPriority" >= 0 AND "routingPriority" <= 1000000);

-- Keep each transport copy's observed identity and immutable business-route snapshot.
ALTER TABLE "InboundDelivery"
  ADD COLUMN "observedMessageId" TEXT,
  ADD COLUMN "messageIdHash" CHAR(64),
  ADD COLUMN "semanticHash" CHAR(64),
  ADD COLUMN "routedQueueId" INTEGER,
  ADD COLUMN "routedDepartmentId" INTEGER;

CREATE TABLE "InboundMessageClaim" (
  "messageIdHash" CHAR(64) NOT NULL,
  "normalizedMessageId" TEXT NOT NULL,
  -- NULL/version=0 denotes a historical delivery whose logical semantic content cannot be
  -- reconstructed safely by SQL. Runtime treats a later copy as a visible conflict, never a
  -- silent duplicate. New claims are version=1 and always provide a semantic hash.
  "semanticHash" CHAR(64),
  "semanticHashVersion" INTEGER NOT NULL DEFAULT 1,
  "winnerDeliveryId" INTEGER NOT NULL,
  "routedQueueId" INTEGER,
  "departmentId" INTEGER,
  "ticketId" INTEGER,
  "postId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InboundMessageClaim_pkey" PRIMARY KEY ("messageIdHash")
);

CREATE UNIQUE INDEX "InboundMessageClaim_winnerDeliveryId_key"
  ON "InboundMessageClaim"("winnerDeliveryId");
CREATE INDEX "InboundMessageClaim_routedQueueId_idx"
  ON "InboundMessageClaim"("routedQueueId");
CREATE INDEX "InboundMessageClaim_departmentId_idx"
  ON "InboundMessageClaim"("departmentId");
CREATE INDEX "InboundMessageClaim_ticketId_idx"
  ON "InboundMessageClaim"("ticketId");
CREATE INDEX "InboundDelivery_messageIdHash_idx"
  ON "InboundDelivery"("messageIdHash");
CREATE INDEX "InboundDelivery_observedMessageId_idx"
  ON "InboundDelivery"("observedMessageId");
CREATE INDEX "InboundDelivery_routedQueueId_idx"
  ON "InboundDelivery"("routedQueueId");

-- Preserve every legacy claimed Message-ID in the new table. It is intentionally marked
-- semanticHashVersion=0 instead of incorrectly treating raw MIME bytes as a logical semantic
-- hash (Received/Delivered-To differ for valid CC copies). A future copy of such a historical
-- id therefore fails closed until an operator resolves it.
INSERT INTO "InboundMessageClaim" (
  "messageIdHash",
  "normalizedMessageId",
  "semanticHash",
  "semanticHashVersion",
  "winnerDeliveryId",
  "routedQueueId",
  "departmentId",
  "ticketId",
  "postId",
  "createdAt",
  "updatedAt"
)
SELECT
  encode(digest(d."messageId", 'sha256'), 'hex'),
  d."messageId",
  NULL,
  0,
  d."id",
  d."queueId",
  d."departmentId",
  d."ticketId",
  d."postId",
  d."createdAt",
  d."updatedAt"
FROM "InboundDelivery" d
WHERE d."messageId" IS NOT NULL AND d."messageId" <> ''
ON CONFLICT ("messageIdHash") DO NOTHING;

-- Link legacy transport rows to their new logical claim and retain the original identifier
-- as a non-unique observed value for diagnostics. Route snapshots mirror the historic
-- receiving queue/department; new runtime computes a deterministic owner before ticket work.
UPDATE "InboundDelivery" d
SET
  "observedMessageId" = d."messageId",
  "messageIdHash" = encode(digest(d."messageId", 'sha256'), 'hex'),
  "routedQueueId" = d."queueId",
  "routedDepartmentId" = d."departmentId"
WHERE d."messageId" IS NOT NULL AND d."messageId" <> '';

ALTER TABLE "InboundDelivery"
  ADD CONSTRAINT "InboundDelivery_messageIdHash_fkey"
  FOREIGN KEY ("messageIdHash") REFERENCES "InboundMessageClaim"("messageIdHash")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "InboundDelivery_routedQueueId_fkey"
  FOREIGN KEY ("routedQueueId") REFERENCES "EmailQueue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "InboundDelivery_routedDepartmentId_fkey"
  FOREIGN KEY ("routedDepartmentId") REFERENCES "Department"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InboundMessageClaim"
  ADD CONSTRAINT "InboundMessageClaim_winnerDeliveryId_fkey"
  FOREIGN KEY ("winnerDeliveryId") REFERENCES "InboundDelivery"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "InboundMessageClaim_routedQueueId_fkey"
  FOREIGN KEY ("routedQueueId") REFERENCES "EmailQueue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "InboundMessageClaim_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "Department"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "InboundMessageClaim_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "InboundMessageClaim_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "TicketPost"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
