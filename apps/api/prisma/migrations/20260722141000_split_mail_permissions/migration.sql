-- Replace the historical all-or-nothing admin.mail permission with explicit
-- operational capabilities. This is intentionally idempotent: custom groups that
-- formerly held admin.mail retain all four capabilities; ordinary groups never gain a
-- write capability; the stock Manager gets read-only operational visibility.
UPDATE "StaffGroup" AS g
SET "permissions" = ARRAY(
  SELECT DISTINCT permission
  FROM unnest(
    array_remove(g."permissions", 'admin.mail') ||
    CASE
      WHEN g."isAdmin" OR 'admin.mail' = ANY(g."permissions") THEN
        ARRAY['mail.view', 'mail.replay', 'mail.reconcile', 'mail.configure']::TEXT[]
      WHEN g."title" = 'Manager' THEN ARRAY['mail.view']::TEXT[]
      ELSE ARRAY[]::TEXT[]
    END
  ) AS permission
)
WHERE g."isAdmin" OR 'admin.mail' = ANY(g."permissions") OR g."title" = 'Manager';

-- Remove a stale hidden compatibility key even from a malformed/duplicate group row
-- that did not meet the condition above. New code no longer recognises admin.mail.
UPDATE "StaffGroup"
SET "permissions" = array_remove("permissions", 'admin.mail')
WHERE 'admin.mail' = ANY("permissions");
