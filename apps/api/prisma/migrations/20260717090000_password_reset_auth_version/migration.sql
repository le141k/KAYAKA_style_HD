-- Bind password-reset links to the Staff security state at issuance. Burn every
-- pre-cutover unused link: historical rows did not carry a trustworthy version.
BEGIN;

UPDATE "PasswordReset"
SET "usedAt" = CURRENT_TIMESTAMP
WHERE "usedAt" IS NULL;

ALTER TABLE "PasswordReset"
-- -1 is a fail-closed sentinel: an old API process that inserts without the
-- new column during a rolling cutover can never mint a reset valid for a
-- normal (non-negative) Staff.authVersion.
ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT -1;

-- Keep opportunistic cleanup indexed and enforce one active reset link per staff.
-- All historical links were burned above, so the partial uniqueness invariant is
-- safe to install during the same cutover.
CREATE INDEX "PasswordReset_expiresAt_idx" ON "PasswordReset"("expiresAt");
CREATE INDEX "PasswordReset_staffId_usedAt_idx" ON "PasswordReset"("staffId", "usedAt");
CREATE UNIQUE INDEX "PasswordReset_one_active_per_staff_idx"
ON "PasswordReset"("staffId") WHERE "usedAt" IS NULL;

COMMIT;
