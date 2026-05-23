-- Add isShared toggle to Macro (was a phantom UI checkbox with no column).
ALTER TABLE "Macro" ADD COLUMN "isShared" BOOLEAN NOT NULL DEFAULT true;
