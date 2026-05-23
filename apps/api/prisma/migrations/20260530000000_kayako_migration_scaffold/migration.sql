-- M0: org classification (CLIENT/SUPPLIER/INTERNAL) + Kayako source ids for an
-- idempotent, re-runnable importer (upsert by kayakoId + FK resolution).
CREATE TYPE "OrgType" AS ENUM ('CLIENT', 'SUPPLIER', 'INTERNAL');

ALTER TABLE "Organization" ADD COLUMN "kayakoId" INTEGER;
ALTER TABLE "Organization" ADD COLUMN "orgType" "OrgType" NOT NULL DEFAULT 'CLIENT';
ALTER TABLE "User" ADD COLUMN "kayakoId" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN "kayakoId" INTEGER;
ALTER TABLE "Macro" ADD COLUMN "kayakoId" INTEGER;
ALTER TABLE "Macro" ADD COLUMN "subject" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Macro" ADD COLUMN "isHtml" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "Organization_kayakoId_key" ON "Organization"("kayakoId");
CREATE UNIQUE INDEX "User_kayakoId_key" ON "User"("kayakoId");
CREATE UNIQUE INDEX "Ticket_kayakoId_key" ON "Ticket"("kayakoId");
CREATE UNIQUE INDEX "Macro_kayakoId_key" ON "Macro"("kayakoId");
