-- GOAL_PUBLIC_SECURITY S2-2 — establish one stable ownership identity (data migration).
--
-- Safe, idempotent and reversible-by-data: this migration does NOT add the DB-level
-- case-insensitive UNIQUE invariant (that asserts "an email is never shared" and must wait
-- until the audit report — `npm run audit:ownership -w apps/api` — has resolved any real
-- case-insensitive duplicate groups against production data). It only:
--   1. normalizes existing UserEmail addresses that can be normalized without colliding, and
--   2. backfills Ticket.userId where a normalized requester email maps to exactly one user.
-- Ambiguous (email → >1 user) and unlinked (email → 0 users) rows are left untouched and are
-- surfaced by the audit report for manual resolution.

-- 1. Normalize existing UserEmail addresses (trim + lowercase), but ONLY for rows whose
--    normalized form does not collide with another existing row. Colliding groups are left
--    as-is (they would violate the current case-sensitive UNIQUE(email)) and reported.
UPDATE "UserEmail" ue
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"))
  AND NOT EXISTS (
    SELECT 1 FROM "UserEmail" o
    WHERE o."id" <> ue."id"
      AND o."email" = lower(btrim(ue."email"))
  );

-- 2. Backfill Ticket.userId from the normalized requester email, but only when that email
--    maps to EXACTLY ONE user (unambiguous ownership). Never overwrites an existing userId.
UPDATE "Ticket" t
SET "userId" = sub."userId"
FROM (
  SELECT lower(btrim("email")) AS norm, min("userId") AS "userId"
  FROM "UserEmail"
  GROUP BY lower(btrim("email"))
  HAVING count(DISTINCT "userId") = 1
) sub
WHERE t."userId" IS NULL
  AND t."requesterEmail" <> ''
  AND lower(btrim(t."requesterEmail")) = sub.norm;
