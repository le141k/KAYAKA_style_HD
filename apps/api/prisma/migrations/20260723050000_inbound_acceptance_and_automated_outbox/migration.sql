-- Immutable inbound acceptance snapshots and durable customer automation.
--
-- This migration is expand-only and forward-safe: the existing staff-reply
-- postId unique index remains in place (PostgreSQL permits many NULL values),
-- so a staff post still has exactly one outbox command while automated ticket
-- mail can exist without a post.

CREATE TYPE "OutboundEmailKind" AS ENUM (
  'STAFF_REPLY',
  'AUTORESPONDER',
  'AUTO_CLOSE',
  'WORKFLOW',
  'REPORT',
  'INTERNAL_NOTIFICATION'
);
CREATE TYPE "WorkflowEmailEventState" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'RETRY', 'QUARANTINED');

ALTER TABLE "EmailQueue"
  ADD COLUMN "configGeneration" INTEGER NOT NULL DEFAULT 0;

-- A scheduled report is compiled outside its short persistence transaction. These
-- generations fence an old scanner from committing/sending a result after an
-- operator changed the definition, recipient list, owner, format or schedule.
ALTER TABLE "Report"
  ADD COLUMN "configGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ReportSchedule"
  ADD COLUMN "configGeneration" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "InboundDelivery"
  ADD COLUMN "sendAutoresponder" BOOLEAN,
  ADD COLUMN "routingSnapshot" JSONB;

ALTER TABLE "InboundMessageClaim"
  ADD COLUMN "sendAutoresponder" BOOLEAN;

ALTER TABLE "OutboundEmail"
  ADD COLUMN "kind" "OutboundEmailKind" NOT NULL DEFAULT 'STAFF_REPLY',
  ALTER COLUMN "postId" DROP NOT NULL,
  ALTER COLUMN "ticketId" DROP NOT NULL,
  ADD COLUMN "reportRunId" INTEGER,
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "OutboundEmail_reportRunId_key" ON "OutboundEmail"("reportRunId");
CREATE UNIQUE INDEX "OutboundEmail_idempotencyKey_key" ON "OutboundEmail"("idempotencyKey");

-- A breach event is the durable source/fence for SLA rule effects.  It is
-- inserted in the same transaction as the ticket escalation and its internal
-- notification commands, so a scheduler crash cannot orphan either side.
CREATE TABLE "SlaEscalationEvent" (
  "id" TEXT NOT NULL,
  "ticketId" INTEGER NOT NULL,
  "breachType" "SlaTargetType" NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SlaEscalationEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SlaEscalationEvent_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "SlaEscalationEvent_sourceKey_key" ON "SlaEscalationEvent"("sourceKey");
CREATE UNIQUE INDEX "SlaEscalationEvent_ticketId_breachType_key"
  ON "SlaEscalationEvent"("ticketId", "breachType");
CREATE INDEX "SlaEscalationEvent_ticketId_idx" ON "SlaEscalationEvent"("ticketId");

ALTER TABLE "OutboundEmail"
  ADD COLUMN "slaEscalationEventId" TEXT;

CREATE INDEX "OutboundEmail_slaEscalationEventId_idx"
  ON "OutboundEmail"("slaEscalationEventId");

ALTER TABLE "OutboundEmail"
  ADD CONSTRAINT "OutboundEmail_slaEscalationEventId_fkey"
  FOREIGN KEY ("slaEscalationEventId") REFERENCES "SlaEscalationEvent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OutboundEmail"
  ADD CONSTRAINT "OutboundEmail_reportRunId_fkey"
  FOREIGN KEY ("reportRunId") REFERENCES "ReportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "WorkflowEmailEvent" (
  "id" TEXT NOT NULL,
  "ticketId" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "sourceKey" TEXT NOT NULL,
  "actions" JSONB NOT NULL,
  "state" "WorkflowEmailEventState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseVersion" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkflowEmailEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkflowEmailEvent_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WorkflowEmailEvent_ticketId_idx" ON "WorkflowEmailEvent"("ticketId");
CREATE UNIQUE INDEX "WorkflowEmailEvent_sourceKey_key" ON "WorkflowEmailEvent"("sourceKey");
CREATE INDEX "WorkflowEmailEvent_state_nextAttemptAt_idx" ON "WorkflowEmailEvent"("state", "nextAttemptAt");
CREATE INDEX "WorkflowEmailEvent_leaseExpiresAt_idx" ON "WorkflowEmailEvent"("leaseExpiresAt");

-- Durable automated mail is deliberately fail-closed when a required template is
-- absent. Production databases are not necessarily created with the development
-- seed, so install both customer templates before the new runtime can enqueue a
-- command. Existing operator-customized rows are never overwritten.
INSERT INTO "EmailTemplate" ("key", "locale", "subject", "htmlBody", "textBody", "updatedAt")
VALUES (
  'autoresponder',
  'en',
  '[{{mask}}] Your request has been received',
  '<p>Hello {{name}},</p><p>We have received your support request and assigned it ticket number <strong>{{mask}}</strong>.</p><p>Our team will respond within the next 4 business hours.</p><p>Best regards,<br>23 Telecom Support</p>',
  'Hello {{name}},\n\nYour request has been received ({{mask}}). We will respond within 4 business hours.\n\n23 Telecom Support',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key", "locale") DO NOTHING;

-- Staff-facing internal notifications are now fail-closed transactional
-- commands.  Provide release-safe defaults for production databases that do
-- not run the development seed.  Existing operator-customized rows remain
-- untouched; the deploy sentinel must reject empty/broken custom templates.
INSERT INTO "EmailTemplate" ("key", "locale", "subject", "htmlBody", "textBody", "updatedAt")
VALUES
(
  'notify_staff_assigned',
  'en',
  '[Assigned] {{mask}}: {{subject}}',
  '<p>Hello {{name}},</p><p>Ticket <strong>{{mask}}</strong> has been assigned to you.</p><p>Subject: {{subject}}</p><p>Please review and respond within your SLA window.</p><p>Best regards,<br>23 Telecom Help Desk</p>',
  'Hello {{name}},\n\nTicket {{mask}} has been assigned to you.\nSubject: {{subject}}\n\nPlease review and respond within your SLA window.\n\n23 Telecom Help Desk',
  CURRENT_TIMESTAMP
),
(
  'notify_staff_user_replied',
  'en',
  '[User Reply] {{mask}}: {{subject}}',
  '<p>Hello {{name}},</p><p>A customer has replied to ticket <strong>{{mask}}</strong>.</p><p>Subject: {{subject}}</p><p>Please review and respond as needed.</p><p>Best regards,<br>23 Telecom Help Desk</p>',
  'Hello {{name}},\n\nA customer has replied to ticket {{mask}}.\nSubject: {{subject}}\n\nPlease review and respond as needed.\n\n23 Telecom Help Desk',
  CURRENT_TIMESTAMP
),
(
  'sla_breach_internal',
  'en',
  '[SLA BREACH] {{breachType}} — {{mask}} — {{minutesOverdue}}m overdue',
  '<p><strong>SLA Breach Alert</strong></p><p>Ticket <strong>{{mask}}</strong> has breached the {{breachType}} SLA target by {{minutesOverdue}} minutes.</p><p>Subject: {{subject}}</p><p>Rule: {{rule}}</p><p>Please take immediate action.</p>',
  'SLA BREACH\nTicket: {{mask}}\nType: {{breachType}}\nOverdue: {{minutesOverdue}}m\nSubject: {{subject}}\nRule: {{rule}}\n\nPlease take immediate action.',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key", "locale") DO NOTHING;

-- The old worker used the "received" acknowledgement for a closed ticket, which
-- was both misleading and non-durable. Seed the required customer template before
-- new runtime code can queue AUTO_CLOSE commands.
INSERT INTO "EmailTemplate" ("key", "locale", "subject", "htmlBody", "textBody", "updatedAt")
VALUES (
  'ticket_auto_closed',
  'en',
  '[{{mask}}] Your ticket has been closed',
  '<p>Hello {{name}},</p><p>Your ticket <strong>{{mask}}</strong> has been closed due to inactivity.</p><p>If you still need help, reply to this email to reopen it.</p><p>Best regards,<br>23 Telecom Support</p>',
  'Hello {{name}},\n\nYour ticket {{mask}} has been closed due to inactivity. If you still need help, reply to this email to reopen it.\n\n23 Telecom Support',
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key", "locale") DO NOTHING;
