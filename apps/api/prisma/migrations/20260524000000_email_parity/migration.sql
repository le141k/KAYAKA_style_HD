-- Migration: 20260524000000_email_parity
-- Sections A (CC/BCC recipients) + B (email parser rules) + C (no schema change)

-- CreateEnum: RecipientRole
CREATE TYPE "RecipientRole" AS ENUM ('CC', 'BCC');

-- CreateEnum: ParserRuleType
CREATE TYPE "ParserRuleType" AS ENUM ('PRE_PARSE', 'POST_PARSE');

-- CreateEnum: ParserMatchType
CREATE TYPE "ParserMatchType" AS ENUM ('ALL', 'ANY');

-- CreateTable: TicketRecipient
CREATE TABLE "TicketRecipient" (
    "id"       SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "email"    TEXT NOT NULL,
    "role"     "RecipientRole" NOT NULL,
    "addedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketRecipient_ticketId_email_key" ON "TicketRecipient"("ticketId", "email");
CREATE INDEX "TicketRecipient_ticketId_idx" ON "TicketRecipient"("ticketId");

-- AddForeignKey
ALTER TABLE "TicketRecipient" ADD CONSTRAINT "TicketRecipient_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: EmailParserRule
CREATE TABLE "EmailParserRule" (
    "id"             SERIAL NOT NULL,
    "title"          TEXT NOT NULL,
    "ruleType"       "ParserRuleType" NOT NULL DEFAULT 'PRE_PARSE',
    "matchType"      "ParserMatchType" NOT NULL DEFAULT 'ALL',
    "stopProcessing" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled"      BOOLEAN NOT NULL DEFAULT true,
    "sortOrder"      INTEGER NOT NULL DEFAULT 0,
    "criteria"       JSONB NOT NULL DEFAULT '[]',
    "actions"        JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "EmailParserRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailParserRule_isEnabled_sortOrder_idx" ON "EmailParserRule"("isEnabled", "sortOrder");

-- Migration mapping notes (swticketrecipients JOIN swticketemails; recipienttype 1→CC 2→BCC)
-- Migration mapping notes (swparserrules + swparserrulecriteria + swparserruleactions)
