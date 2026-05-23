-- P3: agent productivity — time tracking, follow-ups, saved ticket-list views.

CREATE TABLE "TimeEntry" (
  "id" SERIAL NOT NULL,
  "ticketId" INTEGER NOT NULL,
  "staffId" INTEGER NOT NULL,
  "minutes" INTEGER NOT NULL,
  "note" TEXT,
  "spentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TimeEntry_ticketId_idx" ON "TimeEntry"("ticketId");
CREATE INDEX "TimeEntry_staffId_idx" ON "TimeEntry"("staffId");

CREATE TABLE "FollowUp" (
  "id" SERIAL NOT NULL,
  "ticketId" INTEGER NOT NULL,
  "staffId" INTEGER NOT NULL,
  "dueAt" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "completed" BOOLEAN NOT NULL DEFAULT false,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FollowUp_ticketId_idx" ON "FollowUp"("ticketId");
CREATE INDEX "FollowUp_dueAt_idx" ON "FollowUp"("dueAt");

CREATE TABLE "SavedView" (
  "id" SERIAL NOT NULL,
  "staffId" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "filters" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedView_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SavedView_staffId_idx" ON "SavedView"("staffId");

ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SavedView" ADD CONSTRAINT "SavedView_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;
