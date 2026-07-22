-- Scheduled reports do not have an HTTP principal at execution time.  Give
-- each schedule an explicit staff owner so the worker can apply that person's
-- current department predicate and current report.run permission.
ALTER TABLE "ReportSchedule" ADD COLUMN "ownerStaffId" INTEGER;

ALTER TABLE "ReportSchedule"
  ADD CONSTRAINT "ReportSchedule_ownerStaffId_fkey"
  FOREIGN KEY ("ownerStaffId") REFERENCES "Staff"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ReportSchedule_ownerStaffId_idx" ON "ReportSchedule"("ownerStaffId");

-- The old schema did not record who authorized a schedule.  There is no safe
-- historical backfill, so disable every legacy schedule rather than let a new
-- worker execute it as an unscoped/global report.  An administrator can create
-- a replacement schedule, which records a live owner explicitly.
UPDATE "ReportSchedule"
SET "isEnabled" = false
WHERE "ownerStaffId" IS NULL AND "isEnabled" = true;
