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

The last migration adds the queue configuration fence, snapshots the autoresponder
decision on each accepted delivery, and permits durable `AUTORESPONDER`, `AUTO_CLOSE`,
`WORKFLOW`, `REPORT`, and `INTERNAL_NOTIFICATION` outbox commands without a TicketPost.
It also adds `WorkflowEmailEvent`, `SlaEscalationEvent`, and report/schedule generation
fences. It preserves `InboundDelivery_messageId_key` and `OutboundEmail_postId_key`:
PostgreSQL permits multiple NULL `postId` values while a staff reply still has exactly
one outbox command per post.

## 1. Safe release route

1. Set TELECOM_HD_INBOUND_DELIVERY_ENABLED=false and TELECOM_HD_IMAP_ENABLED=false in the
   owner-only .env.prod file.
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

### Pre-cutover PIPE ingress sign-off (required)

`TELECOM_HD_INBOUND_DELIVERY_ENABLED=false` is the global runtime kill switch for IMAP delivery and
`POST /api/inbound/pipe`: background IMAP fetch/accept is stopped, PIPE is rejected with retryable
503 before MIME parsing, and the ledger drain does not create tickets. An explicitly invoked IMAP
reconcile may still take a UID baseline while the gate is closed; it does not fetch, accept, route,
or create a ticket, and is the safe preparation step for an IMAP canary. Before each code/migration
deployment, record the following in the attended release change record and obtain the release owner's
sign-off:

- MTA/alias/transport rule or webhook sender is disabled or diverted away from this API, with the
  exact route identifier and the time verified;
- every non-canary PIPE queue is disabled in the operator UI; and
- the operator confirms that no sender can reach the old or new API PIPE endpoint until the
  disposable PostgreSQL and real IMAP/PIPE gates are green.

Do not rely only on `TELECOM_HD_IMAP_ENABLED=false`; it controls polling only. The shared delivery
gate must be false for a normal deploy. Re-enable one documented canary MTA route only after an
attended configuration-only restart sets `TELECOM_HD_INBOUND_DELIVERY_ENABLED=true`, then record
the same evidence when it is stopped again before the next normal deployment.

## 2. Disposable PostgreSQL proof

Restore a production-like sanitized backup into a disposable PostgreSQL database. Never run
this rehearsal against production. From apps/api, apply the whole migration history, run it
again to prove the already-applied state, then run the aggregate-only SQL check:

```bash
export DATABASE_URL="$DISPOSABLE_DATABASE_URL" # do not echo this value
npx prisma migrate deploy
npx prisma migrate deploy
npx prisma migrate status
psql "$DISPOSABLE_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  template_count integer;
  enum_count integer;
  migration_count integer;
  post_nullable text;
  ticket_nullable text;
  index_count integer;
  config_column_count integer;
BEGIN
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
      ('Report', 'configGeneration'),
      ('ReportSchedule', 'configGeneration')
    );
  IF config_column_count <> 3 THEN
    RAISE EXCEPTION 'queue/report generation fence is incomplete';
  END IF;

  SELECT COUNT(*) INTO migration_count
  FROM "_prisma_migrations"
  WHERE migration_name IN (
    '20260723010000_inbound_message_claims',
    '20260723020000_durable_outbound_outbox',
    '20260723030000_inbound_raw_mime_staging_fence',
    '20260723040000_ticket_post_inbound_message_id',
    '20260723050000_inbound_acceptance_and_automated_outbox'
  ) AND finished_at IS NOT NULL AND rolled_back_at IS NULL;
  IF migration_count <> 5 THEN
    RAISE EXCEPTION 'required inbound/outbox migration is not complete';
  END IF;
END
$$;
SQL
unset DATABASE_URL
```

With two API processes connected to that same disposable database, prove all of the
following against real PostgreSQL:

- concurrent Message-ID claim has one durable winner;
- a stale fetch then queue configuration/epoch change cannot accept a delivery;
- concurrent reconcile has one winner and an audited loser;
- a slow delivery that outlives a lease has one settled outcome;
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

## 4. Controlled production canary

After both disposable gates pass, create one non-customer-impacting IMAP canary queue through
the operator UI. Use the current configGeneration/cursorGeneration returned by the UI; never
update queue rows directly. Reconcile it explicitly with FROM_NOW (the required reason and
confirmation) or bounded BACKFILL according to the written mailbox plan. Keep all other IMAP
queues disabled and the MTA/PIPE route stopped.

deploy-prod.sh intentionally refuses a release environment with IMAP enabled. After the release,
the following is an operator-approved configuration-only API restart, not a second code deploy:

```bash
# First prove the same release and fully applied schema.
git fetch origin main
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
export TELECOM_HD_WEB_BUILD_ID="$(./scripts/web-build-id.sh .env.prod)"
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod \
  run --rm --no-deps -T api npx prisma migrate status

# Edit only .env.prod: TELECOM_HD_INBOUND_DELIVERY_ENABLED=true. Keep IMAP false for
# a PIPE-only canary, or set TELECOM_HD_IMAP_ENABLED=true only for a reconciled IMAP canary.
# Do not change release SHA, images, schema, queue configuration, or the edge here.
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod \
  up -d --no-build --no-deps --force-recreate api
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod \
  exec -T api wget -qO- http://127.0.0.1:4000/api/health
```

Deliver one controlled canary message and wait for up to two 60-second supervisor cycles. In
/admin/mail or GET /api/admin/email-queues/inbound/health, verify the canary's connection, poll
start/completion and accepted timestamps; OK sync state; expected epoch/generation/cursor; zero
unexpected alert/quarantine; and the durable outbound status. Retry an outbound command only
through POST /api/admin/outbound-emails/:id/retry with mail.configure; never insert a new SMTP row.

Enable one remaining queue at a time only after the previous queue stays green. Before any later
normal code/migration deployment, set TELECOM_HD_INBOUND_DELIVERY_ENABLED=false and
TELECOM_HD_IMAP_ENABLED=false, stop/re-divert PIPE delivery, and use ./scripts/deploy-prod.sh
again. This intentionally repeats the quiesce boundary.

## 5. Incident stop and rollback

For an inbound incident, stop the MTA/PIPE route, set TELECOM_HD_INBOUND_DELIVERY_ENABLED=false
(and TELECOM_HD_IMAP_ENABLED=false), and run the same configuration-only API restart. This stops
new IMAP/PIPE acceptance and ledger processing while retaining the durable ledger and forensic
evidence for a later attended recovery.

After the forward migration boundary, prefer forward recovery. If that is impossible, restore the
exact PostgreSQL + uploads/raw-MIME + Redis triplet recorded by deploy-prod.sh and restore only the
matching immutable application image under an attended recovery plan. Do not run an old binary
against the new schema, invent a down migration, or delete ledger/raw evidence.
