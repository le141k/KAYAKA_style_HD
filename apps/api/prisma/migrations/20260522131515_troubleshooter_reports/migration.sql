-- CreateEnum
CREATE TYPE "ReportKind" AS ENUM ('TABULAR', 'SUMMARY', 'MATRIX');

-- CreateTable
CREATE TABLE "TroubleshooterCategory" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "parentId" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TroubleshooterCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TroubleshooterStep" (
    "id" SERIAL NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "contents" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TroubleshooterStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TroubleshooterStepLink" (
    "id" SERIAL NOT NULL,
    "fromId" INTEGER NOT NULL,
    "toId" INTEGER NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TroubleshooterStepLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ReportKind" NOT NULL DEFAULT 'SUMMARY',
    "definition" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportSchedule" (
    "id" SERIAL NOT NULL,
    "reportId" INTEGER NOT NULL,
    "cron" TEXT NOT NULL,
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ReportSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TroubleshooterStep_categoryId_idx" ON "TroubleshooterStep"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "TroubleshooterStepLink_fromId_toId_key" ON "TroubleshooterStepLink"("fromId", "toId");

-- CreateIndex
CREATE INDEX "ReportSchedule_reportId_idx" ON "ReportSchedule"("reportId");

-- AddForeignKey
ALTER TABLE "TroubleshooterCategory" ADD CONSTRAINT "TroubleshooterCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "TroubleshooterCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TroubleshooterStep" ADD CONSTRAINT "TroubleshooterStep_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "TroubleshooterCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TroubleshooterStepLink" ADD CONSTRAINT "TroubleshooterStepLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "TroubleshooterStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TroubleshooterStepLink" ADD CONSTRAINT "TroubleshooterStepLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "TroubleshooterStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportSchedule" ADD CONSTRAINT "ReportSchedule_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
