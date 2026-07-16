-- GOAL_PUBLIC_SECURITY S3 (race fix): stamp each refresh-token row with the staff
-- authVersion it was issued under. A refresh whose row.authVersion no longer matches
-- the current staff record is rejected, so logout-all / password / permission changes
-- cannot be outrun by a session that is concurrently rotating its refresh token.
ALTER TABLE "RefreshToken" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;
