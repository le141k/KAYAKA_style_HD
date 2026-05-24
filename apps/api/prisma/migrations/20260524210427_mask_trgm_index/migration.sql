-- CreateIndex
CREATE INDEX "Ticket_mask_idx" ON "Ticket" USING GIN ("mask" gin_trgm_ops);
