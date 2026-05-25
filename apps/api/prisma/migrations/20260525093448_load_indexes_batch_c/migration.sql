-- CreateIndex
CREATE INDEX "RefreshToken_staffId_revokedAt_idx" ON "RefreshToken"("staffId", "revokedAt");

-- CreateIndex
CREATE INDEX "RefreshToken_staffId_expiresAt_idx" ON "RefreshToken"("staffId", "expiresAt");

-- CreateIndex
CREATE INDEX "ReportSchedule_isEnabled_nextRunAt_idx" ON "ReportSchedule"("isEnabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "TicketAuditLog_createdAt_idx" ON "TicketAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "Workflow_isEnabled_sortOrder_idx" ON "Workflow"("isEnabled", "sortOrder");
