-- Capture-only inbound testing is a durable hold, not a variant of ACCEPTED.
-- PostgreSQL enum additions are forward-only and safe for a rolling deploy: existing
-- rows remain unchanged, and the old runtime simply never writes the new value.
ALTER TYPE "InboundDeliveryState" ADD VALUE IF NOT EXISTS 'CAPTURED' AFTER 'ACCEPTED';
