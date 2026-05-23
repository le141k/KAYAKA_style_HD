-- M2: per-queue autoresponder gate (Kayako swemailqueues.ticketautoresponder).
ALTER TABLE "EmailQueue" ADD COLUMN "sendAutoresponder" BOOLEAN NOT NULL DEFAULT false;
