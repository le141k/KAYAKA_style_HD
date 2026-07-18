-- GOAL_PUBLIC_SECURITY S3-1: per-staff auth version for immediate session invalidation.
-- Embedded in each access token as the `av` claim; the JWT guard rejects any token whose
-- `av` no longer matches the DB, so password/disable/group/permission changes and logout-all
-- take effect on the very next request. Existing tokens (no `av`) are invalidated on deploy.
ALTER TABLE "Staff" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;
