-- Expand: durable ACL owner for inbound operator actions. The receiving queue department and
-- deterministic recipient route can differ from the department of the ticket eventually
-- created by a parser rule or existing-thread reply, so neither is sufficient by itself.
CREATE TYPE "InboundDeliveryEffectiveOwnerKind" AS ENUM ('RECEIVING', 'ROUTED', 'TICKET', 'UNRESOLVED');

ALTER TABLE "InboundDelivery"
  ADD COLUMN "effectiveOwnerKind" "InboundDeliveryEffectiveOwnerKind" NOT NULL DEFAULT 'UNRESOLVED',
  ADD COLUMN "effectiveOwnerDepartmentId" INTEGER,
  ADD COLUMN "effectiveOwnerTicketId" INTEGER;

ALTER TABLE "InboundDelivery"
  ADD CONSTRAINT "InboundDelivery_effectiveOwnerTicketId_fkey"
  FOREIGN KEY ("effectiveOwnerTicketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Direct finalized deliveries take the actual ticket relation, which lets later ticket department
-- moves be evaluated dynamically by the authorization predicate.
UPDATE "InboundDelivery" AS delivery
SET
  "effectiveOwnerKind" = 'TICKET',
  "effectiveOwnerTicketId" = ticket."id",
  "effectiveOwnerDepartmentId" = ticket."departmentId"
FROM "Ticket" AS ticket
WHERE delivery."ticketId" = ticket."id";

-- A duplicate logical RFC Message-ID copy inherits a ticket only when its semantic hash exactly
-- proves it is the same logical message. A conflict must never inherit another message's ACL.
UPDATE "InboundDelivery" AS delivery
SET
  "effectiveOwnerKind" = 'TICKET',
  "effectiveOwnerTicketId" = ticket."id",
  "effectiveOwnerDepartmentId" = ticket."departmentId"
FROM "InboundMessageClaim" AS claim
JOIN "Ticket" AS ticket ON ticket."id" = claim."ticketId"
WHERE delivery."effectiveOwnerKind" = 'UNRESOLVED'
  AND delivery."messageIdHash" = claim."messageIdHash"
  AND delivery."semanticHash" = claim."semanticHash"
  AND claim."semanticHashVersion" = 1;

-- Do not resurrect a deleted direct/claim ticket through a stale route snapshot: those rows stay
-- UNRESOLVED (admin only) until a deliberate replay establishes a fresh owner.
UPDATE "InboundDelivery"
SET
  "effectiveOwnerKind" = 'ROUTED',
  "effectiveOwnerDepartmentId" = "routedDepartmentId"
WHERE "effectiveOwnerKind" = 'UNRESOLVED'
  AND "ticketId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "InboundMessageClaim" AS claim
    WHERE claim."messageIdHash" = "InboundDelivery"."messageIdHash"
      AND claim."semanticHash" = "InboundDelivery"."semanticHash"
      AND claim."semanticHashVersion" = 1
      AND claim."ticketId" IS NOT NULL
  )
  AND "routedDepartmentId" IS NOT NULL;

UPDATE "InboundDelivery"
SET
  "effectiveOwnerKind" = 'RECEIVING',
  "effectiveOwnerDepartmentId" = "departmentId"
WHERE "effectiveOwnerKind" = 'UNRESOLVED'
  AND "ticketId" IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "InboundMessageClaim" AS claim
    WHERE claim."messageIdHash" = "InboundDelivery"."messageIdHash"
      AND claim."semanticHash" = "InboundDelivery"."semanticHash"
      AND claim."semanticHashVersion" = 1
      AND claim."ticketId" IS NOT NULL
  )
  AND "departmentId" IS NOT NULL;

CREATE INDEX "InboundDelivery_effectiveOwnerKind_effectiveOwnerDepartmentId_state_idx"
ON "InboundDelivery"("effectiveOwnerKind", "effectiveOwnerDepartmentId", "state");

CREATE INDEX "InboundDelivery_effectiveOwnerTicketId_idx"
ON "InboundDelivery"("effectiveOwnerTicketId");
