-- Keep RFC threading identifiers separate from the untrusted inbound-delivery
-- idempotency namespace.  A sender can spoof a Message-ID emitted by staff; that
-- must create/process the inbound message, not be collapsed into the outbound post.
--
-- This is forward-only: add/backfill the inbound key first, establish its unique
-- constraint, then replace the old overloaded unique index with a lookup index.
-- It is a contract boundary: quiesce every old API/inbound worker before applying
-- it (the production deploy runbook already stops the API and drains BullMQ first).
BEGIN;

ALTER TABLE "TicketPost"
  ADD COLUMN "inboundMessageId" TEXT;

-- Existing inbound posts are identified by the only durable source marker we can
-- trust during this migration: their EMAIL creation mode.  `messageId` was made
-- unique by the prior migration, so this backfill cannot introduce duplicate
-- non-null inbound keys.  Empty historic values remain NULL.
UPDATE "TicketPost"
SET "inboundMessageId" = NULLIF(BTRIM("messageId"), '')
WHERE "creationMode" = 'EMAIL'
  AND "inboundMessageId" IS NULL
  AND "messageId" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TicketPost"
    WHERE "inboundMessageId" IS NOT NULL
    GROUP BY "inboundMessageId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce inbound Message-ID uniqueness: duplicate non-empty TicketPost.inboundMessageId values exist';
  END IF;
END $$;

CREATE UNIQUE INDEX "TicketPost_inboundMessageId_key"
  ON "TicketPost"("inboundMessageId");

-- `messageId` remains indexed for RFC In-Reply-To/References resolution, but it
-- is no longer an idempotency constraint.  OutboundEmail.messageId remains
-- independently unique for SMTP command identity.
DROP INDEX IF EXISTS "TicketPost_messageId_key";
CREATE INDEX IF NOT EXISTS "TicketPost_messageId_idx" ON "TicketPost"("messageId");

COMMIT;
