-- Durable provenance for the audited CAPTURED -> ACCEPTED transition.  A normal
-- inbound canary may process only a row bearing this marker; a historical
-- ACCEPTED/RETRY delivery must never become canary work merely because an
-- operator typed its numeric id into configuration.
ALTER TABLE "InboundDelivery"
  ADD COLUMN "capturePromotedAt" TIMESTAMP(3);

CREATE INDEX "InboundDelivery_queueId_capturePromotedAt_state_idx"
  ON "InboundDelivery"("queueId", "capturePromotedAt", "state");
