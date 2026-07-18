-- Inbound mail can be delivered concurrently by IMAP and webhook transports.
-- Canonicalize legacy values, represent "no Message-ID" as NULL, then make the
-- RFC Message-ID the database-enforced idempotency key. PostgreSQL UNIQUE allows
-- any number of NULLs, while every real Message-ID is globally unique.

BEGIN;

UPDATE "TicketPost"
SET "messageId" = NULL
WHERE "messageId" IS NULL OR BTRIM("messageId") = '';

UPDATE "TicketPost"
SET "messageId" = BTRIM("messageId")
WHERE "messageId" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "TicketPost"
    WHERE "messageId" IS NOT NULL
    GROUP BY "messageId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce inbound Message-ID uniqueness: duplicate non-empty TicketPost.messageId values exist';
  END IF;
END $$;

DROP INDEX IF EXISTS "TicketPost_messageId_idx";
ALTER TABLE "TicketPost" ALTER COLUMN "messageId" DROP DEFAULT;

CREATE UNIQUE INDEX "TicketPost_messageId_key" ON "TicketPost"("messageId");

COMMIT;
