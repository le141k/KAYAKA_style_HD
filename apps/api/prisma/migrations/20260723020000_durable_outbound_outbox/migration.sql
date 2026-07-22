-- Durable, transactional SMTP outbox for staff public replies.
--
-- This is an additive migration. Existing notification/template paths remain
-- compatible; ticket replies created by the new runtime atomically create one
-- OutboundEmail row together with the TicketPost and audit entry.

CREATE TYPE "OutboundEmailState" AS ENUM (
  'QUEUED', 'PROCESSING', 'SENT', 'RETRY', 'FAILED', 'AMBIGUOUS'
);

CREATE TYPE "OutboundRecipientRole" AS ENUM ('TO', 'CC', 'BCC');

CREATE TABLE "OutboundEmail" (
  "id" TEXT NOT NULL,
  "ticketId" INTEGER NOT NULL,
  "postId" INTEGER NOT NULL,
  "emailQueueId" INTEGER,
  "state" "OutboundEmailState" NOT NULL DEFAULT 'QUEUED',
  "messageId" TEXT NOT NULL,
  "fromAddress" TEXT NOT NULL,
  "replyToAddress" TEXT,
  "subject" TEXT NOT NULL,
  "htmlBody" TEXT NOT NULL,
  "textBody" TEXT NOT NULL,
  "inReplyTo" TEXT,
  "references" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3),
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseVersion" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "providerResponse" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OutboundEmail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutboundEmail_postId_key" ON "OutboundEmail"("postId");
CREATE UNIQUE INDEX "OutboundEmail_messageId_key" ON "OutboundEmail"("messageId");
CREATE INDEX "OutboundEmail_ticketId_idx" ON "OutboundEmail"("ticketId");
CREATE INDEX "OutboundEmail_state_nextAttemptAt_idx" ON "OutboundEmail"("state", "nextAttemptAt");
CREATE INDEX "OutboundEmail_leaseExpiresAt_idx" ON "OutboundEmail"("leaseExpiresAt");

ALTER TABLE "OutboundEmail"
  ADD CONSTRAINT "OutboundEmail_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OutboundEmail_postId_fkey"
  FOREIGN KEY ("postId") REFERENCES "TicketPost"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OutboundEmail_emailQueueId_fkey"
  FOREIGN KEY ("emailQueueId") REFERENCES "EmailQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OutboundEmailRecipient" (
  "id" SERIAL NOT NULL,
  "outboundEmailId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "role" "OutboundRecipientRole" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OutboundEmailRecipient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutboundEmailRecipient_outboundEmailId_email_key"
  ON "OutboundEmailRecipient"("outboundEmailId", "email");
CREATE INDEX "OutboundEmailRecipient_outboundEmailId_role_idx"
  ON "OutboundEmailRecipient"("outboundEmailId", "role");

ALTER TABLE "OutboundEmailRecipient"
  ADD CONSTRAINT "OutboundEmailRecipient_outboundEmailId_fkey"
  FOREIGN KEY ("outboundEmailId") REFERENCES "OutboundEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OutboundEmailAttachment" (
  "id" SERIAL NOT NULL,
  "outboundEmailId" TEXT NOT NULL,
  "sourceAttachmentId" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "sha1" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OutboundEmailAttachment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OutboundEmailAttachment_outboundEmailId_sourceAttachmentId_key"
  ON "OutboundEmailAttachment"("outboundEmailId", "sourceAttachmentId");
CREATE INDEX "OutboundEmailAttachment_sourceAttachmentId_idx"
  ON "OutboundEmailAttachment"("sourceAttachmentId");

ALTER TABLE "OutboundEmailAttachment"
  ADD CONSTRAINT "OutboundEmailAttachment_outboundEmailId_fkey"
  FOREIGN KEY ("outboundEmailId") REFERENCES "OutboundEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OutboundEmailAttachment_sourceAttachmentId_fkey"
  FOREIGN KEY ("sourceAttachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
