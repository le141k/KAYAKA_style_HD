-- The raw-MIME reaper verifies whether an externalised storage key is already
-- referenced by a durable delivery while it holds the staging-row fence. This
-- lookup must not scan the terminal ledger and prolong capture-arming cleanup.
CREATE INDEX "InboundDelivery_rawStorageKey_idx"
  ON "InboundDelivery"("rawStorageKey");
