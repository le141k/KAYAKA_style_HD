-- AlterTable: add new columns to ReportSchedule
ALTER TABLE "ReportSchedule" ADD COLUMN "format" TEXT NOT NULL DEFAULT 'json';
ALTER TABLE "ReportSchedule" ADD COLUMN "lastRunAt" TIMESTAMP(3);
ALTER TABLE "ReportSchedule" ADD COLUMN "nextRunAt" TIMESTAMP(3);

-- CreateTable: ReportRun
CREATE TABLE "ReportRun" (
    "id" SERIAL NOT NULL,
    "reportId" INTEGER NOT NULL,
    "triggeredBy" TEXT NOT NULL DEFAULT 'manual',
    "staffId" INTEGER,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "resultKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportRun_reportId_idx" ON "ReportRun"("reportId");

-- AddForeignKey
ALTER TABLE "ReportRun" ADD CONSTRAINT "ReportRun_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
