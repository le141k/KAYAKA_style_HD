-- GOAL_PUBLIC_SECURITY S3-3: direct refresh-token lookup by `jti` + rotation `familyId`,
-- replacing the capped Argon2 candidate scan. Existing refresh tokens are already
-- invalidated by the S3 authVersion cutover, so clear them before adding the NOT NULL
-- opaque identifiers (avoids backfilling ids that would be unusable anyway).
DELETE FROM "RefreshToken";
ALTER TABLE "RefreshToken" ADD COLUMN "jti" TEXT NOT NULL;
ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT NOT NULL;
CREATE UNIQUE INDEX "RefreshToken_jti_key" ON "RefreshToken"("jti");
CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
