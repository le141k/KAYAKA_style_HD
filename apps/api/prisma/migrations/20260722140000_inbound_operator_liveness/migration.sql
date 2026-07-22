-- Inbound operator liveness. All fields are advisory timestamps rather than cursor
-- correctness state, so adding them is forward-only and safe for a live ledger.
ALTER TABLE "EmailQueue" ADD COLUMN "lastConnectionAttemptAt" TIMESTAMP(3);
ALTER TABLE "EmailQueue" ADD COLUMN "lastDisconnectedAt" TIMESTAMP(3);
ALTER TABLE "EmailQueue" ADD COLUMN "lastConnectionErrorAt" TIMESTAMP(3);
ALTER TABLE "EmailQueue" ADD COLUMN "lastPollStartedAt" TIMESTAMP(3);
ALTER TABLE "EmailQueue" ADD COLUMN "lastPollCompletedAt" TIMESTAMP(3);
