-- Batch B: indexes + uniqueness for the agent-productivity tables.
CREATE INDEX IF NOT EXISTS "FollowUp_staffId_idx" ON "FollowUp"("staffId");
CREATE UNIQUE INDEX IF NOT EXISTS "SavedView_staffId_name_key" ON "SavedView"("staffId", "name");
