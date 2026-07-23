-- A raw-MIME staging reservation belongs to the receiving queue until its
-- marker/ledger handshake is finalized. Capture arming checks this durable
-- ownership under the same EmailQueue row lock, so a normal worker cannot
-- leave raw bytes behind a newly capture-retired queue after rollback.
ALTER TABLE "InboundRawMimeStaging"
  ADD COLUMN "queueId" INTEGER;

-- Filesystem unlink cannot participate in a PostgreSQL transaction. Persist a
-- REAPING fence before unlink so acceptance (which accepts ACTIVE only) cannot
-- revive a row if the following stage delete rolls back after file removal.
CREATE TYPE "InboundRawMimeStagingState" AS ENUM ('ACTIVE', 'COMMITTED', 'REAPING');

ALTER TABLE "InboundRawMimeStaging"
  ADD COLUMN "state" "InboundRawMimeStagingState" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "InboundRawMimeStaging_queueId_leaseExpiresAt_idx"
  ON "InboundRawMimeStaging"("queueId", "leaseExpiresAt");

CREATE INDEX "InboundRawMimeStaging_state_leaseExpiresAt_idx"
  ON "InboundRawMimeStaging"("state", "leaseExpiresAt");

ALTER TABLE "InboundRawMimeStaging"
  ADD CONSTRAINT "InboundRawMimeStaging_queueId_fkey"
  FOREIGN KEY ("queueId") REFERENCES "EmailQueue"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
