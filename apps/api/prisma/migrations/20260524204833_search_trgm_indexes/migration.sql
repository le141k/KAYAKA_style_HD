-- CreateIndex
CREATE INDEX "Ticket_subject_idx" ON "Ticket" USING GIN ("subject" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Ticket_requesterEmail_idx" ON "Ticket" USING GIN ("requesterEmail" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Ticket_requesterName_idx" ON "Ticket" USING GIN ("requesterName" gin_trgm_ops);
