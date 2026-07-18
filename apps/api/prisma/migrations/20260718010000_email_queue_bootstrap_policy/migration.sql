-- Per-queue bootstrap intent, set by an explicit operator reconcile (FROM_NOW / BACKFILL).
-- Overrides the global TELECOM_HD_IMAP_BOOTSTRAP_POLICY for one queue's next bootstrap so
-- the mode chosen at reconcile time is honoured regardless of the global default.

CREATE TYPE "EmailQueueBootstrapPolicy" AS ENUM ('FROM_NOW', 'BACKFILL');

ALTER TABLE "EmailQueue" ADD COLUMN "bootstrapPolicy" "EmailQueueBootstrapPolicy";
ALTER TABLE "EmailQueue" ADD COLUMN "bootstrapBackfillLimit" INTEGER;
