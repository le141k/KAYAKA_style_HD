# Inbound mail and automated-email production cutover

This runbook is the release-specific gate for the inbound acceptance and durable
customer-email changes. It supplements [DEPLOY.md](DEPLOY.md) and does not replace its
DB/uploads/Redis recovery, edge, or security checks.

The release applies the forward-only sequence:

- 20260723010000_inbound_message_claims
- 20260723020000_durable_outbound_outbox
- 20260723030000_inbound_raw_mime_staging_fence
- 20260723040000_ticket_post_inbound_message_id
- 20260723050000_inbound_acceptance_and_automated_outbox
- 20260723060000_inbound_capture_only
- 20260723061000_email_queue_mailbox
- 20260723062000_inbound_capture_promotion_marker
- 20260723063000_inbound_delivery_effective_owner
- 20260723064000_capture_queue_retirement
- 20260723065000_inbound_raw_mime_stage_queue_fence
- 20260723066000_inbound_raw_storage_lookup_index

The last seven migrations add the queue configuration fence, terminal `CAPTURED` inbound state,
explicit per-queue IMAP mailbox/folder selection, and audited promotion provenance. `CAPTURED` keeps
raw MIME for attended review but is never selected by the drain. A promotion-only normal canary
requires `capturePromotedAt`, so a typed historical `ACCEPTED`/`RETRY` row cannot be processed merely
because its numeric id was entered in configuration. `20260723063000` installs the effective inbound
operator owner: pre-ticket rows are scoped to their immutable receiving/route department, while a
ticket-owned row follows that ticket's current department through an FK and otherwise fails closed.
`20260723064000_capture_queue_retirement` makes an attended capture queue an irreversible evidence
channel: `captureRetiredAt` is latched before IMAP MIME is fetched, the queue is disabled when it first
records terminal capture evidence, and PostgreSQL prevents clearing the marker, re-enabling a disabled
marked queue, or deleting it. A captured delivery may still be deliberately promoted by the later
normal-canary procedure; the queue can never again accept fresh normal ingress. Create a new queue and
a new mailbox/folder for every later capture attempt.
`20260723065000_inbound_raw_mime_stage_queue_fence` adds durable receiving-queue ownership to a
raw-MIME staging reservation. Capture arming uses that queue ownership as a fail-closed barrier: it
must not retire a queue while any of its staging reservations remain.
`20260723066000_inbound_raw_storage_lookup_index` bounds the reaper's ledger-pointer verification by
external raw-storage key, so that a large terminal-delivery ledger cannot unnecessarily prolong the
staging fence or capture-arming cleanup.
The prior migration snapshots the autoresponder
decision on each accepted delivery, and permits durable `AUTORESPONDER`, `AUTO_CLOSE`,
`WORKFLOW`, `REPORT`, and `INTERNAL_NOTIFICATION` outbox commands without a TicketPost.
It also adds `WorkflowEmailEvent`, `SlaEscalationEvent`, and report/schedule generation
fences. It preserves `InboundDelivery_messageId_key` and `OutboundEmail_postId_key`:
PostgreSQL permits multiple NULL `postId` values while a staff reply still has exactly
one outbox command per post.

## 1. Safe release route

1. Set `TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false`,
   `TELECOM_HD_INBOUND_DELIVERY_ENABLED=false`,
   `TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=false`, and
   `TELECOM_HD_IMAP_ENABLED=false` in the owner-only `.env.prod` file.
2. Disable or divert the MTA/PIPE route and disable every non-canary email queue through
   the operator UI. The shared delivery gate rejects PIPE before its body parser and keeps
   accepted/retry ledger rows durable but unprocessed; diversion still prevents MTA retry
   backlog and protects any old API instance during the rollout boundary.
3. Deploy the clean origin/main checkout with ./scripts/deploy-prod.sh. The helper pauses
   BullMQ, proves the DB/uploads/Redis recovery triplet, applies Prisma migrations, checks
   the automated-email templates without printing their bodies, and starts only the internal
   stack.
4. Complete the disposable PostgreSQL and real IMAP/PIPE gates below before enabling a
   production mailbox or MTA route.

Never start an old application binary against this schema and never create a down migration.
Before any capture-only restart, stop every old API/inbound worker completely and prove that only the
current release can reach the selected queue. This is a quiesced hand-off, not a rolling mixed-version
deployment: an old binary cannot enforce `captureRetiredAt`.

### Pre-cutover PIPE ingress sign-off (required)

With `TELECOM_HD_INBOUND_DELIVERY_ENABLED=false` and capture-only disabled, the global runtime gate
stops IMAP fetch/accept, rejects PIPE with retryable 503 before MIME parsing, and keeps the ledger
drain from creating tickets. An explicitly invoked IMAP reconcile may still take a UID baseline while
the gate is closed; it does not fetch, accept, route, or create a ticket, and is the safe preparation
step for an IMAP canary. Capture-only is the deliberate narrow exception after this gate: it is
**IMAP-folder-only** and rejects every PIPE request with 503 before body parsing. Only the selected
IMAP queue may store terminal `CAPTURED` raw MIME, without ticket/post/attachment, autoresponder,
or outbox work. Before each code/migration deployment, record the following in the
attended release change record and obtain the release owner's sign-off:

- MTA/alias/transport rule or webhook sender is disabled or diverted away from this API, with the
  exact route identifier and the time verified;
- every non-canary PIPE queue is disabled in the operator UI; and
- the operator confirms that no sender can reach the old or new API PIPE endpoint until the
  disposable PostgreSQL and real IMAP/PIPE gates are green.

Do not rely only on `TELECOM_HD_IMAP_ENABLED=false`; it controls polling only. For a normal deploy,
outbound delivery, normal inbound delivery, capture-only, and IMAP must all be false. The first
attended mailbox canary is the separate **capture-only** procedure below; only a later, explicitly
approved normal-delivery canary may set `TELECOM_HD_INBOUND_DELIVERY_ENABLED=true`.

## 2. Disposable PostgreSQL proof

Restore a production-like sanitized backup into a disposable PostgreSQL database. Never run
this rehearsal against production. From apps/api, apply the whole migration history, run it
again to prove the already-applied state, then run the aggregate-only SQL check:

```bash
# Configure an owner-only libpq service (PGSERVICE + ~/.pg_service.conf and
# ~/.pgpass, or an equivalent secret-managed PG* environment) for this disposable
# database. Do not put a database URL in shell history or a process argument.
export PGSERVICE=telecom_hd_disposable
export DATABASE_URL="$DISPOSABLE_DATABASE_URL" # keep this secret out of output
npx prisma migrate deploy
npx prisma migrate deploy
npx prisma migrate status
psql -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  template_count integer;
  enum_count integer;
  inbound_state_labels text[];
  migration_count integer;
  post_nullable text;
  ticket_nullable text;
  index_count integer;
  config_column_count integer;
  mailbox_not_null boolean;
  mailbox_default text;
  mailbox_constraint_valid boolean;
  effective_owner_columns integer;
  effective_owner_enum text[];
  effective_owner_fk_valid boolean;
  capture_retired_column_count integer;
  capture_retired_index_count integer;
  capture_retired_trigger_count integer;
  raw_stage_queue_column_count integer;
  raw_stage_queue_index_count integer;
  raw_stage_queue_fk_valid boolean;
  raw_stage_queue_fk_delete_action "char";
  raw_stage_state_nullable text;
  raw_stage_state_type text;
  raw_stage_state_index_count integer;
  raw_storage_lookup_index_count integer;
  raw_stage_state_labels text[];
  probe_email text;
BEGIN
  -- Unique inside this disposable transaction so a sanitized backup cannot turn a
  -- CHECK probe into an unrelated emailAddress unique-constraint failure.
  probe_email := format('mailbox-probe-%s@example.invalid', txid_current());
  SELECT COUNT(*) INTO template_count
  FROM "EmailTemplate"
  WHERE ("key", "locale") IN (
    ('autoresponder', 'en'),
    ('ticket_auto_closed', 'en'),
    ('notify_staff_assigned', 'en'),
    ('notify_staff_user_replied', 'en'),
    ('sla_breach_internal', 'en')
  )
    -- Match MailService exactly: BTRIM alone would accept tab/newline-only
    -- template fields that the runtime correctly treats as empty.
    AND NULLIF(regexp_replace("subject", '[[:space:]]+', '', 'g'), '') IS NOT NULL
    AND NULLIF(regexp_replace("htmlBody", '[[:space:]]+', '', 'g'), '') IS NOT NULL
    AND NULLIF(regexp_replace("textBody", '[[:space:]]+', '', 'g'), '') IS NOT NULL;
  IF template_count <> 5 THEN
    RAISE EXCEPTION 'required automated email templates are missing or empty';
  END IF;

  SELECT COUNT(*) INTO enum_count
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'OutboundEmailKind'
    AND e.enumlabel IN (
      'STAFF_REPLY', 'AUTORESPONDER', 'AUTO_CLOSE', 'WORKFLOW', 'REPORT',
      'INTERNAL_NOTIFICATION'
    );
  IF enum_count <> 6 THEN
    RAISE EXCEPTION 'OutboundEmailKind is incomplete';
  END IF;

  -- Enum ordering is semantic SQL state. The migration must insert CAPTURED directly
  -- after ACCEPTED, not append it after SKIPPED merely because the label exists.
  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
    INTO inbound_state_labels
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'InboundDeliveryState';
  IF inbound_state_labels IS DISTINCT FROM ARRAY[
    'ACCEPTED', 'CAPTURED', 'PROCESSING', 'PROCESSED', 'RETRY', 'QUARANTINED', 'SKIPPED'
  ] THEN
    RAISE EXCEPTION 'InboundDeliveryState has an unexpected CAPTURED enum order: %', inbound_state_labels;
  END IF;

  SELECT is_nullable INTO post_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'OutboundEmail' AND column_name = 'postId';
  IF post_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'OutboundEmail.postId must be nullable for automated commands';
  END IF;

  SELECT is_nullable INTO ticket_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'OutboundEmail' AND column_name = 'ticketId';
  IF ticket_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'OutboundEmail.ticketId must be nullable for REPORT commands';
  END IF;

  SELECT COUNT(*) INTO index_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN ('InboundDelivery_messageId_key', 'OutboundEmail_postId_key',
                      'OutboundEmail_messageId_key', 'OutboundEmail_idempotencyKey_key',
                      'OutboundEmail_reportRunId_key', 'WorkflowEmailEvent_sourceKey_key',
                      'SlaEscalationEvent_sourceKey_key',
                      'SlaEscalationEvent_ticketId_breachType_key');
  IF index_count <> 8 THEN
    RAISE EXCEPTION 'inbound/outbox compatibility unique index is absent';
  END IF;

  IF to_regclass('public."WorkflowEmailEvent"') IS NULL
     OR to_regclass('public."SlaEscalationEvent"') IS NULL THEN
    RAISE EXCEPTION 'durable workflow/SLA event table is absent';
  END IF;

  SELECT COUNT(*) INTO config_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND (table_name, column_name) IN (
      ('EmailQueue', 'configGeneration'),
      ('EmailQueue', 'mailbox'),
      ('Report', 'configGeneration'),
      ('ReportSchedule', 'configGeneration')
    );
  IF config_column_count <> 4 THEN
    RAISE EXCEPTION 'queue/report generation or mailbox fence is incomplete';
  END IF;

  -- Do not accept a pre-existing/drifted mailbox column merely because it has the
  -- right name. Prisma requires this field to be NOT NULL with the legacy INBOX
  -- default, and capture/poll CAS fences depend on a concrete persisted value.
  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO mailbox_not_null, mailbox_default
  FROM pg_attribute a
  JOIN pg_class c ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname = 'public'
    AND c.relname = 'EmailQueue'
    AND a.attname = 'mailbox'
    AND a.attnum > 0
    AND NOT a.attisdropped;
  IF mailbox_not_null IS DISTINCT FROM TRUE
     OR mailbox_default IS DISTINCT FROM (quote_literal('INBOX') || '::text') THEN
    RAISE EXCEPTION 'EmailQueue.mailbox must be NOT NULL with default INBOX';
  END IF;

  SELECT convalidated INTO mailbox_constraint_valid
  FROM pg_constraint
  WHERE conrelid = 'public."EmailQueue"'::regclass
    AND conname = 'EmailQueue_mailbox_valid'
    AND contype = 'c';
  IF mailbox_constraint_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'EmailQueue_mailbox_valid must exist and be validated';
  END IF;

  SELECT COUNT(*) INTO effective_owner_columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'InboundDelivery'
    AND column_name IN ('effectiveOwnerKind', 'effectiveOwnerDepartmentId', 'effectiveOwnerTicketId');
  IF effective_owner_columns <> 3 THEN
    RAISE EXCEPTION 'InboundDelivery effective-owner columns are incomplete';
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
    INTO effective_owner_enum
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'InboundDeliveryEffectiveOwnerKind';
  IF effective_owner_enum IS DISTINCT FROM ARRAY['RECEIVING', 'ROUTED', 'TICKET', 'UNRESOLVED'] THEN
    RAISE EXCEPTION 'InboundDelivery effective-owner enum is incomplete: %', effective_owner_enum;
  END IF;

  SELECT convalidated INTO effective_owner_fk_valid
  FROM pg_constraint
  WHERE conrelid = 'public."InboundDelivery"'::regclass
    AND conname = 'InboundDelivery_effectiveOwnerTicketId_fkey'
    AND contype = 'f';
  IF effective_owner_fk_valid IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'InboundDelivery effective-owner ticket FK is absent or unvalidated';
  END IF;

  SELECT COUNT(*) INTO capture_retired_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'EmailQueue'
    AND column_name = 'captureRetiredAt';
  IF capture_retired_column_count <> 1 THEN
    RAISE EXCEPTION 'EmailQueue.captureRetiredAt is absent';
  END IF;

  SELECT COUNT(*) INTO capture_retired_index_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'EmailQueue'
    AND indexname = 'EmailQueue_isEnabled_type_captureRetiredAt_idx';
  IF capture_retired_index_count <> 1 THEN
    RAISE EXCEPTION 'capture-retired queue index is absent';
  END IF;

  SELECT COUNT(*) INTO capture_retired_trigger_count
  FROM pg_trigger AS trigger_row
  JOIN pg_class AS queue_table ON queue_table.oid = trigger_row.tgrelid
  JOIN pg_namespace AS queue_namespace ON queue_namespace.oid = queue_table.relnamespace
  WHERE queue_namespace.nspname = 'public'
    AND queue_table.relname = 'EmailQueue'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgname IN (
      'EmailQueue_capture_retirement_update_guard',
      'EmailQueue_capture_retirement_delete_guard'
    );
  IF capture_retired_trigger_count <> 2 THEN
    RAISE EXCEPTION 'capture-retired queue guards are absent';
  END IF;

  SELECT COUNT(*) INTO raw_stage_queue_column_count
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'InboundRawMimeStaging'
    AND column_name = 'queueId';
  IF raw_stage_queue_column_count <> 1 THEN
    RAISE EXCEPTION 'InboundRawMimeStaging.queueId is absent';
  END IF;

  SELECT COUNT(*) INTO raw_stage_queue_index_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'InboundRawMimeStaging'
    AND indexname = 'InboundRawMimeStaging_queueId_leaseExpiresAt_idx';
  IF raw_stage_queue_index_count <> 1 THEN
    RAISE EXCEPTION 'raw-MIME staging queue/lease index is absent';
  END IF;

  SELECT convalidated, confdeltype
    INTO raw_stage_queue_fk_valid, raw_stage_queue_fk_delete_action
  FROM pg_constraint
  WHERE conrelid = 'public."InboundRawMimeStaging"'::regclass
    AND conname = 'InboundRawMimeStaging_queueId_fkey'
    AND contype = 'f';
  IF raw_stage_queue_fk_valid IS DISTINCT FROM TRUE
     OR raw_stage_queue_fk_delete_action IS DISTINCT FROM 'n' THEN
    RAISE EXCEPTION 'raw-MIME staging queue FK is absent, unvalidated, or not ON DELETE SET NULL';
  END IF;

  SELECT is_nullable, udt_name
    INTO raw_stage_state_nullable, raw_stage_state_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'InboundRawMimeStaging'
    AND column_name = 'state';
  IF raw_stage_state_nullable IS DISTINCT FROM 'NO'
     OR raw_stage_state_type IS DISTINCT FROM 'InboundRawMimeStagingState' THEN
    RAISE EXCEPTION 'InboundRawMimeStaging.state must be NOT NULL InboundRawMimeStagingState';
  END IF;

  SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
    INTO raw_stage_state_labels
  FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'InboundRawMimeStagingState';
  IF raw_stage_state_labels IS DISTINCT FROM ARRAY['ACTIVE', 'COMMITTED', 'REAPING'] THEN
    RAISE EXCEPTION 'InboundRawMimeStagingState has unexpected labels: %', raw_stage_state_labels;
  END IF;

  SELECT COUNT(*) INTO raw_stage_state_index_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'InboundRawMimeStaging'
    AND indexname = 'InboundRawMimeStaging_state_leaseExpiresAt_idx';
  IF raw_stage_state_index_count <> 1 THEN
    RAISE EXCEPTION 'raw-MIME staging state/lease index is absent';
  END IF;

  SELECT COUNT(*) INTO raw_storage_lookup_index_count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename = 'InboundDelivery'
    AND indexname = 'InboundDelivery_rawStorageKey_idx';
  IF raw_storage_lookup_index_count <> 1 THEN
    RAISE EXCEPTION 'InboundDelivery raw-storage lookup index is absent';
  END IF;

  -- A named, validated CHECK(TRUE) is still schema drift. Probe the exact negative
  -- semantics under subtransactions: each attempted row is rolled back and no test
  -- queue remains in the disposable database. Do not weaken this to a name-only check.
  BEGIN
    INSERT INTO "EmailQueue" ("emailAddress", "mailbox")
    VALUES (probe_email, ' leading-space');
    RAISE EXCEPTION 'EmailQueue_mailbox_valid accepts leading whitespace';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO "EmailQueue" ("emailAddress", "mailbox")
    VALUES (probe_email, E'\tleading-tab');
    RAISE EXCEPTION 'EmailQueue_mailbox_valid accepts leading tab whitespace';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO "EmailQueue" ("emailAddress", "mailbox")
    VALUES (probe_email, 'trailing-space ');
    RAISE EXCEPTION 'EmailQueue_mailbox_valid accepts trailing whitespace';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO "EmailQueue" ("emailAddress", "mailbox")
    VALUES (probe_email, E'line\nbreak');
    RAISE EXCEPTION 'EmailQueue_mailbox_valid accepts a line break';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    INSERT INTO "EmailQueue" ("emailAddress", "mailbox")
    VALUES (probe_email, repeat('x', 256));
    RAISE EXCEPTION 'EmailQueue_mailbox_valid accepts more than 255 code points';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  INSERT INTO "EmailQueue" ("emailAddress", "mailbox")
  VALUES (probe_email, 'Helpdesk/Test');
  DELETE FROM "EmailQueue" WHERE "emailAddress" = probe_email;
  BEGIN
    INSERT INTO "EmailQueue" ("emailAddress", "mailbox")
    VALUES (probe_email, '');
    RAISE EXCEPTION 'EmailQueue_mailbox_valid accepts an empty folder';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  SELECT COUNT(*) INTO migration_count
  FROM "_prisma_migrations"
  WHERE migration_name IN (
    '20260723010000_inbound_message_claims',
    '20260723020000_durable_outbound_outbox',
    '20260723030000_inbound_raw_mime_staging_fence',
    '20260723040000_ticket_post_inbound_message_id',
    '20260723050000_inbound_acceptance_and_automated_outbox',
    '20260723060000_inbound_capture_only',
    '20260723061000_email_queue_mailbox',
    '20260723062000_inbound_capture_promotion_marker',
    '20260723063000_inbound_delivery_effective_owner',
    '20260723064000_capture_queue_retirement',
    '20260723065000_inbound_raw_mime_stage_queue_fence',
    '20260723066000_inbound_raw_storage_lookup_index'
  ) AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF migration_count <> 12 THEN
    RAISE EXCEPTION 'required inbound/outbox migration is not complete';
  END IF;
END
$$;
SQL
unset DATABASE_URL
```

### 2.1 Capture-retirement upgrade and historical-inventory proof

The `20260723064000` migration is forward-only. Rehearse it separately on a disposable
production-shaped copy whose migration history ends at `20260723063000`, then apply only the pending
migration with `prisma migrate deploy`:

1. Seed or retain one queue with a `CAPTURED` delivery (or a delivery carrying
   `capturePromotedAt`) and record its queue ID. After the migration, that queue must have a non-null
   `captureRetiredAt` and `isEnabled=false`.
2. Seed or retain a different ordinary oversized/truncated `QUARANTINED` delivery. Its queue must
   remain unmarked unless it independently has `CAPTURED`/`capturePromotedAt` evidence. The migration
   must never infer a historical capture from generic quarantine state.
3. In the disposable database, prove that clearing the marker, re-enabling a disabled marked queue,
   and deleting a marked queue each fail. Repeat `prisma migrate deploy` to prove the applied state is
   idempotent.

Before the production forward migration, inventory possible ambiguous historical evidence without
printing raw MIME or credentials:

```sql
SELECT
  queue."id" AS queue_id,
  queue."emailAddress" AS queue_address,
  queue."isEnabled" AS queue_enabled,
  COUNT(*) AS truncated_quarantine_count,
  MIN(delivery."createdAt") AS first_seen_at,
  MAX(delivery."createdAt") AS last_seen_at
FROM "EmailQueue" AS queue
JOIN "InboundDelivery" AS delivery ON delivery."queueId" = queue."id"
WHERE delivery."state" = 'QUARANTINED'
  AND delivery."truncated" = TRUE
GROUP BY queue."id", queue."emailAddress", queue."isEnabled"
ORDER BY queue."id";
```

Rows in this inventory are **not** proof of an old capture: normal oversized mail is also
quarantined. For every row known to have come from a historical capture test, stop the release and
prepare a reviewed, audited, one-way forward data correction that retires and disables that exact
queue. Do not bulk-mark generic `QUARANTINED` rows, do not casually update queues in production, and
do not enable capture-only until every ambiguous queue is classified and recorded by the release owner.

### 2.2 Raw-MIME staging queue-fence rehearsal

On a disposable copy already migrated through `20260723064000`, apply
`20260723065000_inbound_raw_mime_stage_queue_fence`. Verify the new nullable
`InboundRawMimeStaging.queueId`, `ACTIVE`/`COMMITTED`/`REAPING` state enum, both queue/state lease
indexes and the validated `SET NULL` foreign key. Historical staging rows stay unowned
(`queueId IS NULL`) and start `ACTIVE`: the migration must never guess which queue owned an old raw
file.

Using the current API and real PostgreSQL, prove the durable state machine rather than a mocked
Prisma call:

1. A large message reserves `ACTIVE` before filesystem write. The storage helper writes its durable
   pending marker and a private, fsynced temporary file first. The temp path is deterministic from
   the opaque storage key: `inbound-raw/.staging/<UUID>.tmp` (relative to the uploads root), not an
   untracked random name. Immediately before the final atomic rename, the writer takes a short
   database **publish fence** by locking that `ACTIVE` stage. If a
   reaper has already committed `REAPING`, the writer must abort before publishing a destination
   file. If the writer owns the lock, it performs the atomic rename and refreshes the `ACTIVE` lease
   before committing the short fence transaction. The potentially slow file write is never inside
   that transaction; the brief publish hand-off intentionally is. If that transaction rolls back
   after publish, it must retain the marker and destination file for the durable stage/reaper to
   recover rather than hiding an orphan.
2. Acceptance locks **only** `ACTIVE`, creates the `InboundDelivery` pointer and changes the same
   stage to `COMMITTED` in one database transaction. It must reject `REAPING` (and never create a
   pointer to potentially unlinked bytes).
3. After that commit, the accepted-stage finalizer commits the raw-storage marker and only then
   removes its `COMMITTED` stage. Both post-commit actions are retryable; do **not** turn their
   failure into a new mail acceptance or ticket retry.
4. Failed/duplicate acceptance and expired orphan recovery first commit `ACTIVE → REAPING` in a
   database transaction. Only after that committed fence may the process unlink the filesystem file;
   `removeFile` removes both the published destination and its deterministic pre-publish temp path.
   After successful cleanup it deletes the `REAPING` stage and clears the marker. Filesystem unlink
   is deliberately outside the database transaction.
5. The DB-first bounded reaper scans expired `ACTIVE`, every `COMMITTED`, and every `REAPING` stage
   even when no pending marker exists (crash after reservation/before write). `COMMITTED` must be
   pointer-verified and retain its referenced file; `REAPING` must never be accepted. Capture arming
   invokes this bounded sweep, then still refuses a queue with any remaining queue-bound stage before
   IMAP authentication/MIME fetch or writing `captureRetiredAt`.

Exercise each crash window above, including a crash after the deterministic temp is fsynced but
before the final rename: after the row becomes `REAPING`, `removeFile` must remove
`inbound-raw/.staging/<UUID>.tmp` as well as any destination file. Also race a reaper with the writer
after temp fsync but before rename. That race must have exactly one safe result: `REAPING` wins and
the writer never publishes, or the writer holds the publish fence through rename plus lease refresh
and the `SKIP LOCKED` reaper skips/retries. A failed cleanup must leave durable evidence and keep capture arming
closed. Record only state/counts and filesystem reconciliation status—never raw MIME, storage keys,
credentials, or message bodies. This is an acceptance-rollback gate: a zero `InboundDelivery` backlog
alone is not proof that a queue has no pending durable raw-MIME state.

With two API processes connected to that same disposable database, prove all of the
following against real PostgreSQL:

- concurrent Message-ID claim has one durable winner;
- a stale fetch then queue configuration/epoch change cannot accept a delivery;
- concurrent reconcile has one winner and an audited loser;
- a slow delivery that outlives a lease has one settled outcome;
- a reaper and a large-raw-MIME writer racing between temporary-file fsync and final publish have one
  fenced outcome: `REAPING` prevents rename, or the writer renews `ACTIVE` while holding the stage
  lock and the reaper only proceeds afterwards;
- a crash after private temp fsync but before publish leaves no orphan in
  `inbound-raw/.staging/<UUID>.tmp` after the durable `REAPING` reaper path completes;
- an inbound delivery routed to department A then parser-routed or threaded to B is not visible
  to A once it is ticket-owned; move that ticket B → C and prove the mail-operator predicate
  follows C, while an unresolved/deleted-ticket delivery is admin-only;
- a workflow event crash/restart creates at most one action-level outbox row;
  its requester-change quarantine cannot be replayed into a stale recipient;
- a report scan whose recipients, report definition, schedule owner or owner RBAC
  changes during compilation writes neither `ReportRun` nor an outbox command;
- manual assignment, customer-reply watcher alerts and an SLA breach each commit their
  internal-notification outbox command with their ticket/post/audit/breach source; and
- an SLA rule disabled or an out-of-scope staff recipient between scan and commit creates
  no internal command;
- an interrupted migration is recovered by rolling forward; and
- each test leaves one correct ticket/post/outbox result, a monotonic cursor, and no orphaned
  raw-MIME pointer.

Mocked Prisma tests do not substitute for this gate.

## 3. Real IMAP/PIPE proof

Use GreenMail or Dovecot and a disposable mailbox with InboundMailService.pollNow() or the
normal 60-second supervisor. Never point this test at a customer mailbox. For each case record
ledger state, ticket/post/outbox count, queue epoch/generations, cursor, and audit events.

The repository includes a repeatable local baseline at
`apps/api/src/modules/mail/inbound.imap.int-spec.ts`. It starts disposable PostgreSQL, Redis, and
pinned `greenmail/standalone:2.1.11`, proves a synchronous `FROM_NOW` boundary skips a pre-existing UID,
then accepts and drains exactly the first later UID through a real SMTP/IMAP socket and `pollNow()`.
Run it with `npx vitest run --config vitest.integration.config.ts
src/modules/mail/inbound.imap.int-spec.ts --reporter=dot` from `apps/api`. It is a regression gate,
not a substitute for the complete live matrix below.

- FROM_NOW exact UIDNEXT - 1 boundary and the first UID after it;
- sparse UID BACKFILL after EXPUNGE, including lower-UID failure before a higher UID;
- reconnect, acceptance DB failure, restart, stale lease reclaim, UIDVALIDITY reset, and a
  different mailbox reusing UIDVALIDITY/UID;
- same Message-ID delivered to two queues in opposite order, forged same ID with different
  semantic content, and two headerless messages with identical bytes but different UIDs;
- oversized/truncated MIME and refused replay; PIPE retry/collision and a PIPE/IMAP logical copy;
- an enabled queue with sendAutoresponder=true: exactly one persisted AUTORESPONDER command and
  one SMTP attempt; with it false: no autoresponder; and
- auto-close: one AUTO_CLOSE command with its own Auto-Submitted header.

Also exercise the operator paths: a `WorkflowEmailEvent` list/detail is department-scoped,
its action body is hidden from an unauthorized actor, and a replay requires `mail.replay`, a
fresh `updatedAt`, and a non-empty reason. A malformed snapshot or a changed requester must
remain quarantined. Check a ticket's safe delivery-status projection for an
`INTERNAL_NOTIFICATION`; it must expose no recipient or body.

A halt, transport/semantic collision, unexpected quarantine, incorrect customer mail, duplicate
ticket/post/outbox row, or cursor advance past an unaccepted delivery is a red gate. Preserve
ledger, raw-MIME reference, and audit evidence; never delete them to make the dashboard green.

## 4. Controlled capture-only mailbox canary

After both disposable gates pass, create one non-customer-impacting IMAP canary queue through
the operator UI/API and select a **new dedicated empty mailbox/folder**. Never use a shared
customer/NOC Inbox, Gmail All Mail/Archive/Sent/Trash/Junk, or any provider special-use folder.
The runtime verifies the provider's live IMAP `LIST` special-use flags and refuses a folder that
is missing, non-selectable, special-use, or non-empty; create a fresh folder for every canary.
Once the current API arms this queue, it latches `captureRetiredAt` **before** it authenticates or
fetches MIME. Therefore an attempted capture-only restart permanently consumes the queue/folder even
if no message is ultimately captured or readiness later fails. It is not a reusable test toggle.
The folder selection is a queue field; credentials remain encrypted in the queue and must never
be placed in this document or in a release command. Use the current configGeneration/
cursorGeneration returned by the UI; never update queue rows directly. In capture-only mode use
**FROM_NOW only** (required reason and confirmation): BACKFILL is deliberately refused because a
test canary must never read historical mail. Keep all other IMAP queues disabled and the MTA/PIPE
route stopped. Stop every old API/inbound worker before this configuration-only restart and do not
roll an old image alongside the current one.

deploy-prod.sh intentionally refuses a release environment with IMAP enabled. After the release,
the following is an operator-approved configuration-only API restart, not a second code deploy:

```bash
# First prove the same release and fully applied schema.
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
# The tracked deployment source must be clean. `.env.prod` is intentionally ignored
# and is the only file edited for this attended configuration-only restart.
git diff --quiet
git diff --cached --quiet
export TELECOM_HD_WEB_BUILD_ID="$(./scripts/web-build-id.sh .env.prod)"
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod \
  run --rm --no-deps -T api npx prisma migrate status

# Edit only .env.prod for the attended capture test:
#   TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false
#   TELECOM_HD_INBOUND_DELIVERY_ENABLED=false
#   TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=true
#   TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID=<the one dedicated queue id>
#   TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES=1
#   TELECOM_HD_IMAP_ENABLED=true
# The capture queue id is mandatory. Do not change release SHA, images, schema, queue
# configuration, or the edge here. Run the attended configuration-only capture cap check before
# activation: this test is limited to exactly one captured message. CAPTURED mail does not create
# tickets/posts/attachments/autoresponders or outbox commands; PIPE remains 503 throughout this
# IMAP-only window. It requires an explicit audited
# single-row promotion later. This production-specific portable Bash preflight never sources .env.prod or
# prints its values, so the production host does not need Node.js for this gate.
bash scripts/preflight-production-capture-only.sh .env.prod
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod \
  up -d --no-build --no-deps --force-recreate api
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod \
  exec -T api wget -qO- http://127.0.0.1:4000/api/health
```

Before sending anything, wait until the selected queue shows `syncState=OK`, a visible
`uidValidity` and `lastSeenUid`, **and** health reports `captureTarget.ready=true`. The last flag
is a live per-process proof made after this capture-only restart: IMAP `LIST` found the configured
folder without special-use flags and its lock observed an empty folder. Any `capture_target_not_ready`
alert is a hard stop; do not send a message and do not treat an old cursor as proof. `FROM_NOW`
deliberately discards mail that existed before that synchronous UIDNEXT boundary; sending during
bootstrap would make the canary result ambiguous. Then deliver exactly one controlled canary message
and wait for up to two 60-second supervisor cycles.
In `/admin/mail` or `GET /api/admin/email-queues/inbound/health`, verify the capture-only warning,
the one-message capture limit, exactly the intended queue's connection/poll/accepted timestamps,
`CAPTURED=1`, expected epoch/generation/cursor, and no **canary-delivery-linked**
ticket/post/outbox/attachment change. Do not compare global totals while unrelated scheduled work
is running; identify the canary by its capture delivery id and its audit trail.
Inspect only metadata through the captured-delivery operator view; raw MIME is never exposed through
HTTP. Listing and detail require `mail.view`; promotion requires **both** `mail.view` and the
separate `mail.capture.promote` permission, an audit reason and a current row version. Existing
`mail.replay` grants quarantine replay only; it does not grant promotion into ticket processing. Stop the test
immediately after its one planned message: set capture-only
and IMAP back to `false` and run the same configuration-only API restart. The queue is now a
capture-retired evidence record: it cannot be re-enabled, deleted, reconciled for fresh ingress, or
used by normal IMAP/PIPE acceptance. It is retained only so the reviewed captured delivery can follow
the tightly scoped promotion in section 5. Any later capture test requires a newly created queue and
newly created empty mailbox/folder.

## 5. Promotion-only normal inbound and one-recipient outbound canaries

The normal inbound canary is deliberately **not** a fresh-mailbox or PIPE test. Fresh IMAP/PIPE
acceptance is forbidden in this mode. It can process exactly one reviewed `CAPTURED` delivery that
was created by section 4 and then promoted through the audited API. This is the sole permitted
normal-processing use of its capture-retired queue; it never reopens that queue for new mail. This
prevents a restart from draining an old queue backlog.

1. In the owner-only `.env.prod`, set exactly:

   ```dotenv
   TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=false
   TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=
   TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=
   TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED=false
   TELECOM_HD_IMAP_ENABLED=false
   TELECOM_HD_INBOUND_DELIVERY_ENABLED=true
   TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID=<captured delivery queueId>
   TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID=<reviewed CAPTURED delivery id>
   TELECOM_HD_IMAP_BOOTSTRAP_POLICY=FROM_NOW
   TELECOM_HD_IMAP_BACKFILL_LIMIT=0
   ```

2. Run `bash scripts/preflight-production-normal-canary.sh .env.prod`, then perform the same
   configuration-only API restart used in section 4. A failure is a hard stop; do not remove the
   selectors to “make it work”.
3. In the captured-delivery detail screen verify the exact queue ID, delivery ID, non-truncated
   metadata and current row version. Call only the audited promotion endpoint with a reason. The
   backend refuses any other delivery or a selected delivery in a different queue, writes
   `capturePromotedAt` and its audit record atomically, and the drain requires that marker.
4. Verify exactly one ticket/post and (while outbound remains false) at most the expected durable
   outbox command. Verify that IMAP/PIPE accepted nothing during this restart.
5. Immediately close the normal inbound gate, blank **both** inbound normal-canary selectors, and
   restart the API. Do not leave this promotion scope enabled for routine operation.

Only after that evidence is reviewed may an owner run the separate SMTP canary. Set
`TELECOM_HD_INBOUND_DELIVERY_ENABLED=false`, keep IMAP/capture disabled, set
`TELECOM_HD_OUTBOUND_DELIVERY_ENABLED=true`, and set **both**
`TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID=<one reviewed OutboundEmail CUID>` and
`TELECOM_HD_OUTBOUND_CANARY_RECIPIENT=<one approved mailbox>`. The runtime permits no direct
email, no other outbox ID, and no command with CC/BCC or a mismatched recipient. Verify one provider
acceptance, then set outbound back to `false`, blank both SMTP selectors, and restart before any
scope expansion. Never enable normal inbound and outbound canaries at the same time: startup rejects
that configuration. Before the configuration-only restart, run
`bash scripts/preflight-production-outbound-canary.sh .env.prod`; it also refuses a live IMAP,
capture, normal inbound, or normal-inbound-canary scope while the SMTP selectors are present.

Enable one remaining queue at a time only after the previous queue stays green. Before any later
normal code/migration deployment, set outbound delivery, normal inbound delivery, capture-only,
and IMAP all to `false`, stop/re-divert PIPE delivery, and use ./scripts/deploy-prod.sh again.
This intentionally repeats the quiesce boundary.

## 6. Incident stop and rollback

For an inbound incident, stop the MTA/PIPE route, set normal inbound delivery, capture-only, and
IMAP to `false` (and outbound delivery to `false` if customer mail must stop), and run the same
configuration-only API restart. This stops new IMAP/PIPE acceptance and ledger processing while
retaining the durable ledger and forensic evidence for a later attended recovery.

After the forward migration boundary, prefer forward recovery. If that is impossible, restore the
exact PostgreSQL + uploads/raw-MIME + Redis triplet recorded by deploy-prod.sh and restore only the
matching immutable application image under an attended recovery plan. Do not run an old binary
against the new schema, invent a down migration, or delete ledger/raw evidence.
