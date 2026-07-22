-- Fence large raw-MIME filesystem staging against a concurrent reaper.
--
-- A staging row exists before an opaque file is written. Acceptance deletes that row in the
-- same transaction as the InboundDelivery insert; the reaper locks expired staging rows before
-- deleting their files. Therefore a slow but live acceptance transaction cannot lose its raw
-- MIME between filesystem write and ledger commit.
CREATE TABLE "InboundRawMimeStaging" (
  "storageKey" TEXT NOT NULL,
  "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InboundRawMimeStaging_pkey" PRIMARY KEY ("storageKey")
);

CREATE INDEX "InboundRawMimeStaging_leaseExpiresAt_idx"
  ON "InboundRawMimeStaging"("leaseExpiresAt");
