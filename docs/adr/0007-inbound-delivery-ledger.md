# ADR 0007 — Durable inbound-delivery ledger (fail-closed IMAP/PIPE ingestion)

- Status: Accepted
- Date: 2026-07-17

## Context

Inbound mail (IMAP poll and the `POST /api/inbound/pipe` webhook) previously threaded/created
tickets directly from a parsed message, with the only durability being an IMAP UID watermark in
`Setting`. A production review found several ways this loses or duplicates mail:

- The UID cursor advanced on a moving counter and on any processing outcome, so a poison message,
  an infrastructure error (Prisma/DB/storage), an out-of-order UID, or a crash between the reply
  and the watermark write could **silently drop or double-process** mail.
- First-connect bootstrap could import the whole historical mailbox, or (with no `UIDNEXT`) fail
  open to `1:*`. A `UIDVALIDITY` change auto-advanced into the new UID space, skipping mail.
- Message-ID de-dup missed retries because the id was written in a follow-up `UPDATE`, and mail
  with no Message-ID had no idempotency at all.
- No raw MIME was retained, so a failed message could not be replayed; multiple pollers raced.

## Decision

Introduce a durable **`InboundDelivery` ledger** and split ingestion into **accept** and **drain**.

- **Accept** records every message (raw MIME retained) under a UNIQUE `transportKey`
  (`imap:<queueId>:<uidValidity>:<uid>` or `pipe:-:<externalId|sha256:hash>`). The IMAP
  `EmailQueue.lastSeenUid` cursor advances via a **monotonic CAS** ONLY after durable acceptance;
  any fetch/DB error stops the poll without advancing (**fail-closed** — no silent loss). A
  duplicate key is an idempotent no-op (multi-poller / re-poll safe).
- **Bootstrap** captures the baseline **synchronously at connect** (not the first poll) via an
  explicit `FROM_NOW` / `BACKFILL` policy; it never fails open to `1:*`.
- **`UIDVALIDITY`** changes are **fail-closed**: the queue halts (`syncState =
NEEDS_RECONCILIATION`) for an explicit operator `FROM_NOW` / bounded `BACKFILL` decision.
- **Drain** processes `ACCEPTED`/`RETRY` deliveries with a **leased** CAS claim (`leaseOwner` +
  `leaseExpiresAt`); an expired lease is reclaimed, and terminal writes are lease-gated, so a
  crash mid-processing never strands a delivery in `PROCESSING`. Success → `PROCESSED`, transient
  error → `RETRY` (backoff), attempts exhausted → `QUARANTINED`. A quarantine **never discards** —
  the raw MIME stays for replay.
- **Upgrade/cutover** is safe: the ledger migration halts every already-enabled IMAP queue
  (`NEEDS_RECONCILIATION`) so the deploy can't FROM_NOW over an in-flight cursor; the later
  `20260721010000_inbound_hardening` migration extends the same halt to already-**disabled** IMAP
  queues (a disabled queue re-enabled after upgrade would otherwise FROM_NOW over its legacy cursor).
  An operator reconciles explicitly (RESUME_MIGRATED, FROM_NOW, or bounded BACKFILL).
- **Idempotency** is primarily the transport key; processing additionally de-dups by an _effective_
  Message-ID (the RFC id, else a deterministic `<inbound-<sha256>@23telecom.local>` from the
  content hash), written **atomically** with the ticket/post create — so retries never double-post
  even without a Message-ID.

## Consequences

- Mail is durable (replayable), idempotent, and the cursor is provably fail-closed; both transports
  share the ledger.
- New table + `EmailQueue` cursor columns (migration `20260718000000_inbound_delivery_ledger`); the
  legacy `Setting` `imap/lastSeenUid:<id>` watermark is superseded.
- Raw MIME is stored inline (bounded); very large messages should later externalise to object
  storage via `rawStorageKey`. Full single-transaction atomicity of ticket counters/audit with the
  post (LIFE-03) remains a separate follow-up; the ledger already guarantees no loss and no
  duplicate posts. Per-queue advisory locking is best-effort — correctness rests on the unique
  transport-key claim, not the lock.
- A live-IMAP (GreenMail/Dovecot) rehearsal covering EXPUNGE, reconnect and `UIDVALIDITY` remains a
  required pre-cutover manual gate; the unit suite models the same invariants with a fake ImapFlow.

## Rollback / cutover-back

Rollback is **forward-only, not reversible in place.** The new poller writes its cursor **only** to
`EmailQueue.lastSeenUid` (+ `uidValidity` / `cursorGeneration`) and **never** writes back the legacy
`Setting` `imap/lastSeenUid:<id>` / `imap/state:<id>` watermark. **There is no dual-write.** Once the
ledger cursor has advanced past the legacy watermark, rolling the API binary back to the pre-ledger
build is **unsafe**: the old build would resume from the stale `Setting` watermark and re-fetch —
worse, if `Setting` was never carried forward it could FROM_NOW/`1:*` — silently skipping or
double-handling everything ingested since cutover.

The supported strategy is therefore:

1. **Take a full PostgreSQL backup immediately before the deploy** (schema + data).
2. Deploy forward. Do not expect to downgrade the binary against a ledger-advanced database.
3. If a rollback is genuinely required, **restore the pre-deploy backup** and accept re-processing
   from that point. Re-fetching already-handled mail is safe: **Message-ID idempotency** (the unique
   `InboundDelivery.messageId` / `TicketPost.messageId` claim, plus the effective/synthetic id) makes
   a re-fetch of an already-ticketed message a no-op rather than a duplicate.

This restore-and-reprocess path **MUST be rehearsed against a real PostgreSQL instance before
cutover** — do not treat rollback as a theoretical option validated only in unit tests.
