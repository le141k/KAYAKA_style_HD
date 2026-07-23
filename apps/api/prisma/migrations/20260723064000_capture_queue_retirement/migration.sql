-- A capture-only queue is an evidence-gathering channel, never a reusable normal
-- inbound channel. Latch this field before MIME is fetched so an extra test message,
-- a UIDVALIDITY reset, or a later BACKFILL cannot turn into a normal ticket.
ALTER TABLE "EmailQueue"
  ADD COLUMN "captureRetiredAt" TIMESTAMP(3);

-- CAPTURED and capturePromotedAt are unambiguous evidence of the existing capture
-- lifecycle. Do not infer from generic QUARANTINED rows: normal oversized mail can
-- also be quarantined and must not be silently retired by this additive migration.
WITH captured_queues AS (
  SELECT
    "queueId",
    MIN(COALESCE("capturePromotedAt", "createdAt")) AS "retiredAt"
  FROM "InboundDelivery"
  WHERE "queueId" IS NOT NULL
    AND ("state" = 'CAPTURED' OR "capturePromotedAt" IS NOT NULL)
  GROUP BY "queueId"
)
UPDATE "EmailQueue" AS queue
SET
  "captureRetiredAt" = captured_queues."retiredAt",
  "isEnabled" = FALSE,
  "lastError" = COALESCE(
    queue."lastError",
    'Capture-only queue retired from normal inbound; create a new queue and mailbox for future ingress'
  )
FROM captured_queues
WHERE queue."id" = captured_queues."queueId"
  AND queue."captureRetiredAt" IS NULL;

CREATE INDEX "EmailQueue_isEnabled_type_captureRetiredAt_idx"
  ON "EmailQueue"("isEnabled", "type", "captureRetiredAt");

-- `InboundDelivery.queueId` deliberately uses ON DELETE SET NULL so ordinary
-- historical deliveries can outlive a queue.  That must not become an escape
-- hatch for a capture-retired queue: losing the queue relation would otherwise
-- erase the durable normal-ingress fence.  The application also rejects these
-- changes, but enforce the two irreversible facts in PostgreSQL as defence in
-- depth for every client (including a future admin tool): a marker cannot be
-- cleared and a marked queue cannot be deleted or re-enabled after it has been
-- disabled.
CREATE OR REPLACE FUNCTION "protect_capture_retired_email_queue"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."captureRetiredAt" IS NOT NULL THEN
    IF NEW."captureRetiredAt" IS DISTINCT FROM OLD."captureRetiredAt" THEN
      RAISE EXCEPTION 'capture-retired EmailQueue marker is immutable';
    END IF;
    IF OLD."isEnabled" = FALSE AND NEW."isEnabled" = TRUE THEN
      RAISE EXCEPTION 'capture-retired EmailQueue cannot be re-enabled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EmailQueue_capture_retirement_update_guard"
BEFORE UPDATE ON "EmailQueue"
FOR EACH ROW
EXECUTE FUNCTION "protect_capture_retired_email_queue"();

CREATE OR REPLACE FUNCTION "prevent_capture_retired_email_queue_delete"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."captureRetiredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'capture-retired EmailQueue cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EmailQueue_capture_retirement_delete_guard"
BEFORE DELETE ON "EmailQueue"
FOR EACH ROW
EXECUTE FUNCTION "prevent_capture_retired_email_queue_delete"();
