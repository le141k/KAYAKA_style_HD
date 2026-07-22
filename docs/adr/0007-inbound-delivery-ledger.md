# ADR 0007 — Durable inbound-delivery ledger (fail-closed IMAP/PIPE ingestion)

- Status: Accepted
- Date: 2026-07-17; amended 2026-07-22

## Context

Direct IMAP parsing plus a mutable `Setting` watermark could silently skip mail after a fetch,
storage or DB error, UIDVALIDITY reset, mailbox replacement, out-of-order response, stale poller
or retry. It also made a received copy, a true logical message and a ticket/post the same mutable
thing: two poller processes could disagree on routing or double-post.

The public PIPE ingress has distinct risks: a large body must not be read before authentication,
a caller-controlled queue/department is not a safe routing source, and byte-identical independent
headerless messages must not be collapsed by a content hash.

## Decision

Use a durable **`InboundDelivery` ledger** and split inbound work into acceptance and drain.

### Acceptance and cursor

- Every received transport copy is stored before ticket work. IMAP transport identity is
  `imap:<queueId>:<mailboxEpoch>:<uidValidity>:<uid>`; PIPE uses an enabled queue plus SHA-256 of
  the normalised, mandatory MTA delivery id. Transport retry is idempotent only when its complete
  transport identity and raw content hash match.
- `mailboxEpoch` increments atomically for IMAP identity changes and IMAP ↔ non-IMAP transitions.
  A stale UID from a different mailbox can therefore never be mistaken for a duplicate.
- An IMAP acceptance transaction fences queue id, enabled/type, sync state, epoch, generation and
  UIDVALIDITY. Cursor CAS uses the same fixed snapshot and safe frontier; a stale poller creates no
  delivery after a reconcile/identity boundary.
- `FROM_NOW`/`BACKFILL` are synchronous IMAP operations: under a mailbox lock they snapshot
  `UIDNEXT - 1`, persist the generation/epoch baseline, and return success only then. BACKFILL uses
  actual existing UIDs, not `boundary - N`. Missing IMAP state is fail-closed.

### Logical message identity and routing

- A delivery preserves non-unique `observedMessageId`, raw `contentHash`, semantic hash and its
  receiving queue. A real Message-ID is claimed through a separate `InboundMessageClaim`, not a
  unique field on `InboundDelivery`; every transport copy remains forensic evidence.
- Same normalized Message-ID plus semantic hash is a duplicate (`SKIPPED`). Same Message-ID plus
  different semantic hash is `QUARANTINED`, audited and alerted. Semantic hash excludes per-hop
  trace headers such as Received/Delivered-To.
- Headerless IMAP mail is identified only by its transport identity. Two different UIDs with equal
  bytes remain two deliveries/tickets; a visible duplicate after a UID-space reset is safer than a
  silent loss. PIPE cannot be headerless at the transport layer because delivery id is required.
- Route ownership is deterministic: matching enabled queue recipients, `routingPriority` (lower
  first), then queue id. The decision is persisted before ticket work; trusted PIPE queue address
  is snapshotted as envelope recipient for BCC cases.

### Drain, raw evidence and operations

- Drain claims `ACCEPTED`/due `RETRY`/expired `PROCESSING` rows with a lease token and heartbeat.
  Terminal/retry settle is lease-gated; crash recovery reclaims an expired lease. Ticket create and
  reply keep post, recipients, counters and audit in the same transaction (LIFE-03).
- Failed delivery is retried then quarantined; it is never discarded. Truncated IMAP MIME is
  fast-quarantined and cannot be replayed without safe original refetch.
- Small raw MIME stays inline. Large MIME uses the existing uploads volume with a pending marker,
  fsync/atomic rename, ledger pointer and bounded marker reaper. Quarantined evidence is excluded
  from retention. Capacity is checked against the existing storage reserve and fails closed.
- `/api/inbound/pipe` authenticates before its route-specific parser, preserves raw bytes and
  validates queue/type/id before acceptance. JSON and raw MIME use bounded parsers.
- Poll and drain supervisors are single-flight, expose durable liveness and emit health alerts.
  `mail.view`, `mail.replay`, `mail.reconcile`, and `mail.configure` are separate permissions;
  reconcile/replay state transitions and their reason/audit are transactional.

## Consequences

- `InboundDelivery` is a transport ledger, not the global logical-message uniqueness table.
  Operations must investigate its quarantine/audit rows rather than deleting them to unblock mail.
- Existing cursor/ledger migrations are forward-only. Claim cutover follows expand → dual-write →
  verified PostgreSQL backfill → constraint removal; it is not safe to delete a legacy unique
  constraint before the claim migration has been rehearsed.
- `RESUME_MIGRATED` is valid only for the legacy migration cause. UIDVALIDITY/identity events require
  explicit FROM_NOW or bounded BACKFILL with server-provided allowed modes and a generation CAS.
- A live PostgreSQL + GreenMail/Dovecot matrix remains mandatory before cutover; mocked tests prove
  local invariants but do not prove migration, pooling or IMAP server behaviour.

## Rollback / cutover-back

Rollback is **forward-only**. A code rollback is distinct from a data rollback: an old binary may
not understand new epoch/claim/reconcile fields and must not be started against a ledger-advanced
database. Before deploy, quiesce inbound workers and take/verify one recovery set containing
PostgreSQL, uploads (including `inbound-raw`) and Redis.

If deployment fails after schema/data transition, prefer roll-forward with the corrected binary. A
true data rollback requires restoring the matched pre-deploy recovery set while workers are stopped,
then re-running the controlled mail canary. Do not recreate legacy `Setting` cursors manually, do
not delete ledger evidence, and do not rely on Message-ID dedup alone to justify an unsafe old
binary. The restore path must be rehearsed on real PostgreSQL before production cutover.
