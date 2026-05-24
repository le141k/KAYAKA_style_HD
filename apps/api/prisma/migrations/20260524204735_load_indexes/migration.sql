-- CreateIndex
CREATE INDEX "Ticket_priorityId_idx" ON "Ticket"("priorityId");

-- CreateIndex
CREATE INDEX "Ticket_typeId_idx" ON "Ticket"("typeId");

-- CreateIndex
CREATE INDEX "Ticket_isResolved_idx" ON "Ticket"("isResolved");

-- CreateIndex
CREATE INDEX "Ticket_mergedIntoId_idx" ON "Ticket"("mergedIntoId");

-- CreateIndex
CREATE INDEX "Ticket_dueAt_idx" ON "Ticket"("dueAt");

-- CreateIndex
CREATE INDEX "Ticket_resolutionDueAt_idx" ON "Ticket"("resolutionDueAt");

-- CreateIndex
CREATE INDEX "Ticket_isResolved_isEscalated_mergedIntoId_idx" ON "Ticket"("isResolved", "isEscalated", "mergedIntoId");
