-- Transient BOOTSTRAPPING sync state. A queue an operator reconciled with FROM_NOW /
-- BACKFILL sits in BOOTSTRAPPING until the poller fixes its high-water baseline and flips
-- it to OK via the generation-guarded CAS, so the health view never reports a queue as OK
-- before it actually has a cursor. Isolated in its own migration: Postgres forbids USING a
-- newly added enum value in the same transaction that adds it — nothing here uses it.
ALTER TYPE "EmailQueueSyncState" ADD VALUE IF NOT EXISTS 'BOOTSTRAPPING';
