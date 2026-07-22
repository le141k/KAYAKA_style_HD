-- Mailbox epoch + typed reconcile state.  A UIDVALIDITY/UID pair is only unique
-- within one configured mailbox identity; retaining an explicit epoch prevents a
-- replacement mailbox which happens to reuse both values from being silently
-- treated as an old transport retry.

CREATE TYPE "EmailQueueReconcileCause" AS ENUM (
    'LEGACY_MIGRATION',
    'UIDVALIDITY_CHANGED',
    'MAILBOX_IDENTITY_CHANGED',
    'MANUAL_FORCE',
    'TRANSPORT_COLLISION',
    'UNKNOWN'
);

ALTER TABLE "EmailQueue"
    ADD COLUMN "mailboxEpoch" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "reconcileCause" "EmailQueueReconcileCause",
    ADD COLUMN "reconcileRequestedAt" TIMESTAMP(3);

ALTER TABLE "InboundDelivery"
    ADD COLUMN "mailboxEpoch" INTEGER;

-- All legacy ledger rows were accepted before epochs existed, therefore belong to
-- epoch 1.  Do not cast BigInt UID fields through INTEGER and do not recreate the
-- ledger table: existing raw MIME, leases and tickets remain untouched.
UPDATE "InboundDelivery"
SET "mailboxEpoch" = 1
WHERE "transport" = 'IMAP' AND "mailboxEpoch" IS NULL;

CREATE INDEX "InboundDelivery_queueId_mailboxEpoch_uidValidity_uid_idx"
    ON "InboundDelivery"("queueId", "mailboxEpoch", "uidValidity", "uid");

-- Superseded by the epoch-aware index above.  Keeping both would make Prisma's declared
-- schema drift from the physical database and retains an index that cannot distinguish a
-- replacement mailbox's reused UID space.
DROP INDEX "InboundDelivery_queueId_uidValidity_uid_idx";

-- Keep old IMAP rows in the canonical epoch-aware transport-key namespace.  This
-- prevents a retry of an already accepted legacy delivery from becoming a second
-- ledger row immediately after the application rollout.  The predicate is exact
-- so PIPE keys and non-canonical rows are never rewritten.
UPDATE "InboundDelivery"
SET "transportKey" = 'imap:' || "queueId"::text || ':1:' || "uidValidity"::text || ':' || "uid"::text
WHERE "transport" = 'IMAP'
  AND "queueId" IS NOT NULL
  AND "uidValidity" IS NOT NULL
  AND "uid" IS NOT NULL
  AND "transportKey" = 'imap:' || "queueId"::text || ':' || "uidValidity"::text || ':' || "uid"::text;

-- Only the known upgrade marker may safely receive RESUME_MIGRATED.  A previous
-- runtime could have halted for UIDVALIDITY or another unknown reason; classifying
-- those rows as legacy would make a destructive resume possible.  Unknown states
-- intentionally remain fail-closed and offer only an explicit new baseline.
UPDATE "EmailQueue"
SET "reconcileCause" = CASE
    WHEN "lastError" LIKE 'Upgraded to InboundDelivery ledger%' THEN 'LEGACY_MIGRATION'::"EmailQueueReconcileCause"
    WHEN "lastError" LIKE 'UIDVALIDITY changed%' THEN 'UIDVALIDITY_CHANGED'::"EmailQueueReconcileCause"
    WHEN "lastError" LIKE 'Mailbox identity changed%' THEN 'MAILBOX_IDENTITY_CHANGED'::"EmailQueueReconcileCause"
    ELSE 'UNKNOWN'::"EmailQueueReconcileCause"
END
WHERE "syncState" IN ('NEEDS_RECONCILIATION', 'BOOTSTRAPPING');
