-- SEC-6: per-upload secret binding anonymous orphan attachments to the submit
-- that follows, so a public submitter cannot adopt another submitter's orphan.
ALTER TABLE "Attachment" ADD COLUMN "claimToken" TEXT;
CREATE INDEX IF NOT EXISTS "Attachment_claimToken_idx" ON "Attachment"("claimToken");
