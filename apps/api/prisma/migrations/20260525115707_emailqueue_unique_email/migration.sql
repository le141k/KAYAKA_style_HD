-- D5: enforce one EmailQueue row per address so the importer can upsert
-- atomically (was a non-atomic findFirst+create).
-- CreateIndex
CREATE UNIQUE INDEX "EmailQueue_emailAddress_key" ON "EmailQueue"("emailAddress");
