-- GOAL_PUBLIC_SECURITY S2 — enforce one normalized client identity and durable revocation.
--
-- This migration intentionally FAILS before changing data or schema unless the read-only
-- ownership audit is CLEAN. Operators must run:
--
--   npm run audit:ownership -w apps/api
--
-- and resolve every duplicate/un-normalized UserEmail row first. The transaction leaves the
-- schema/data unchanged on failure; ambiguous production identity data is never auto-merged.
-- If an operator skipped preflight and Prisma recorded this rolled-back migration as failed,
-- resolve the data, run `prisma migrate resolve --rolled-back 20260717000000_client_identity_invariant`,
-- then retry deploy.

BEGIN;

DO $$
DECLARE
  duplicate_groups bigint;
  unnormalized_rows bigint;
BEGIN
  SELECT count(*) INTO duplicate_groups
  FROM (
    SELECT 1
    FROM "UserEmail"
    GROUP BY lower(btrim("email", E' \t\n\r\f\x0B'))
    HAVING count(*) > 1
  ) duplicates;

  SELECT count(*) INTO unnormalized_rows
  FROM "UserEmail"
  WHERE "email" <> lower(btrim("email", E' \t\n\r\f\x0B'));

  IF duplicate_groups > 0 OR unnormalized_rows > 0 THEN
    RAISE EXCEPTION
      'UserEmail ownership is NOT CLEAN (duplicate groups: %, un-normalized rows: %). Run audit:ownership and resolve the reported rows before retrying.',
      duplicate_groups,
      unnormalized_rows;
  END IF;
END $$;

-- Re-run the ownership backfill after operators have resolved any collision that
-- blocked the earlier normalization migration. Without this pass, tickets that
-- became unambiguous during remediation would remain invisible to their owner.
UPDATE "Ticket" t
SET "userId" = owners."userId"
FROM (
  SELECT lower(btrim("email", E' \t\n\r\f\x0B')) AS norm, min("userId") AS "userId"
  FROM "UserEmail"
  GROUP BY lower(btrim("email", E' \t\n\r\f\x0B'))
  HAVING count(DISTINCT "userId") = 1
) owners
WHERE t."userId" IS NULL
  AND btrim(t."requesterEmail", E' \t\n\r\f\x0B') <> ''
  AND lower(btrim(t."requesterEmail", E' \t\n\r\f\x0B')) = owners.norm;

-- Enforce the same ASCII-whitespace trim + lowercase rule used by normalizeEmail().
ALTER TABLE "UserEmail"
  ADD CONSTRAINT "UserEmail_email_normalized_check"
  CHECK ("email" = lower(btrim("email", E' \t\n\r\f\x0B')));

-- The expression index is defence in depth for legacy/direct SQL writers. The existing
-- case-sensitive UserEmail.email unique constraint remains available to Prisma.
CREATE UNIQUE INDEX "UserEmail_email_normalized_key"
  ON "UserEmail" (lower(btrim("email", E' \t\n\r\f\x0B')));

ALTER TABLE "User"
  ADD COLUMN "clientAuthVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ClientLoginToken"
  ADD COLUMN "clientAuthVersion" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "ClientSession"
  ADD COLUMN "clientAuthVersion" INTEGER NOT NULL DEFAULT -1;

-- One deliberate forced client sign-in on rollout: pre-version links/sessions cannot be
-- proven to represent the current identity. New auth material is stamped with the new value.
UPDATE "User" SET "clientAuthVersion" = "clientAuthVersion" + 1;
UPDATE "ClientLoginToken" SET "usedAt" = CURRENT_TIMESTAMP WHERE "usedAt" IS NULL;
UPDATE "ClientSession" SET "revokedAt" = CURRENT_TIMESTAMP WHERE "revokedAt" IS NULL;

-- Advisory locking in ClientAuthService serializes issuance; this index independently
-- guarantees that an owner never has two active (unused) magic-link tokens.
CREATE UNIQUE INDEX "ClientLoginToken_one_active_per_user_key"
  ON "ClientLoginToken" ("userId")
  WHERE "usedAt" IS NULL;

COMMIT;
