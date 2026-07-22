# Production deployment runbook — 23 Telecom Help Desk

Production launch is deliberately split into two gates:

1. `scripts/deploy-prod.sh` installs and verifies an **internal-only** release. It publishes no host
   ports and starts no Caddy/proxy container.
2. HTTPS edge enablement is a separate operator change after the internal audits, cookie smoke,
   trusted-client-IP topology and external firewall checks are green.

Never combine these gates during an incident or a first deployment.

## 1. Pinned stack and host requirements

| Component | Pin |
| --- | --- |
| Node.js | `22.23.1-alpine3.23` |
| Next.js | `15.5.20` |
| NestJS | `11.1.28` |
| PostgreSQL | `16.14-alpine3.23` |
| Redis | `7.4.8-alpine` |
| ClamAV | `1.5.3` |
| Optional edge Caddy | `2.11.4-alpine` |

The production host must have:

- `x86_64`/`amd64` Linux, Docker Engine and the Docker Compose plugin;
- `flock`, Git, at least 8 GiB RAM+swap, at least 4 GiB currently available RAM+swap, and at least
  15 GiB free disk;
- private management access that does not depend on the application edge;
- a clean `main` checkout and an owner-only `.env.prod` file;
- no unrelated containers or volumes inside the dedicated `telecom-hd-prod` Compose project.

ClamAV is mandatory for production, including staff and inbound attachments. Port 3310, PostgreSQL
5432, Redis 6379, API 4000 and web 3000 must never be published to the host.

## 2. Prepare the immutable release

Use Git on the VM; the deploy helper verifies the working tree and commit identity:

```bash
cd /srv/telecom-hd
git fetch origin main
git switch main
git pull --ff-only origin main
git status --short
git rev-parse HEAD
```

Do not deploy an rsync copy without `.git`: release identity, clean-tree enforcement and rollback
provenance depend on the repository metadata. Runtime state (`.env.prod`, backups and Docker
volumes) is VM-owned and must never enter Git.

## 3. Configure `.env.prod`

For a new host:

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod
```

Edit the file only on the VM or through the approved secret-management path. Never print or paste
it into CI, chat or tickets.

Required invariants:

- `TELECOM_HD_RELEASE` identifies `git rev-parse HEAD` (normally its 12-character prefix).
- `TELECOM_HD_PUBLIC_URL=https://real-host`, `DOMAIN` and
  `TELECOM_HD_TURNSTILE_HOSTNAME` refer to the same production host.
- `NEXT_PUBLIC_API_URL` is empty for the recommended same-origin `/api` path.
- JWT secrets are strong and distinct; DB/Redis passwords are URL-safe; the field-encryption key is
  present and exactly 64 hexadecimal characters. It is mandatory in production and must be unchanged
  from the currently running API. The helper compares non-printed fingerprints and performs a
  read-only ciphertext validation before quiesce. **Routine field-key rotation is unsupported**;
  do not edit this key in a normal deploy. Legacy plaintext queue credentials are converted only after
  the verified forward-only migration boundary, with compare-and-swap updates and aggregate-only logs.
- `TELECOM_HD_UPLOAD_DIR` is exactly `/app/uploads`. This is the sole durable Compose volume mount for
  attachments and inbound raw MIME; another path is rejected by preflight and API production startup.
- Keep global IMAP polling explicitly safe until the inbound canary gate: `TELECOM_HD_IMAP_ENABLED=false`.
  `scripts/deploy-prod.sh` now rejects a release env with it enabled, so a stale production
  file cannot consume a mailbox before the live canary proof. Enable it only after the
  documented queue-by-queue canary gate has completed successfully.
  `TELECOM_HD_IMAP_BOOTSTRAP_POLICY=FROM_NOW`, `TELECOM_HD_IMAP_BACKFILL_LIMIT=0`,
  `TELECOM_HD_INBOUND_MAX_ATTEMPTS=5`, and `TELECOM_HD_INBOUND_RAW_RETENTION_DAYS=30`. Queue connection
  settings are stored in the database; `BACKFILL` requires a deliberate non-zero bounded limit.
- SMTP uses a real authenticated relay. Port 587 uses mandatory STARTTLS
  (`TELECOM_HD_SMTP_SECURE=false`); port 465 uses implicit TLS (`true`).
- `TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` are absent from `.env.prod`; first-install creation is
  a terminal prompt in a removed one-shot container.
- `TELECOM_HD_CLAMAV_ENABLED=true`, host `clamav`, and `COMPOSE_PROFILES=scanner`.

Start every public surface closed:

```dotenv
TELECOM_HD_CLIENT_PORTAL_ENABLED=false
TELECOM_HD_CLIENT_UPLOAD_ENABLED=false
TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED=false
TELECOM_HD_PUBLIC_UPLOAD_ENABLED=false
```

The upload switches are independent emergency controls. Verified-client uploads additionally
require the client portal. Anonymous uploads additionally require public ticket creation. Turnstile
credentials and its build-time site key are required before any client/public challenge surface is
enabled.

Validate without exposing values:

```bash
bash scripts/preflight.sh .env.prod
export TELECOM_HD_WEB_BUILD_ID="$(./scripts/web-build-id.sh .env.prod)"
docker compose --profile scanner -f docker-compose.prod.yml \
  --env-file .env.prod config --services
docker compose --profile scanner -f docker-compose.prod.yml \
  --env-file .env.prod config --images
```

Do not print the full rendered Compose configuration; it expands application secrets.

## 4. Internal-only deployment

```bash
chmod +x scripts/preflight.sh scripts/deploy-prod.sh scripts/smoke-prod.sh \
  scripts/bootstrap-admin.sh scripts/web-build-id.sh scripts/validate-uploads-archive.sh \
  scripts/db-backup.sh scripts/db-verify-backup.sh scripts/db-restore.sh \
  scripts/uploads-backup.sh scripts/uploads-verify-backup.sh scripts/uploads-restore.sh
./scripts/deploy-prod.sh
```

For an existing release the helper performs, in order:

1. configuration, resource, architecture, clean-tree and exact fetched-`origin/main` checks;
2. exact inventory and health validation of the dedicated Compose project;
3. pinned image pulls and immutable builds while the old release remains online; the web tag includes
   the digest of its `NEXT_PUBLIC_*` build inputs. The production dependency audit runs inside the
   resulting pinned API image, not through a host Node/npm installation;
4. before quiesce, it verifies field-key continuity/read-only ciphertext compatibility and proves the
   live PostgreSQL role can `CREATE EXTENSION pgcrypto` inside a rolled-back transaction (needed by the
   inbound-message-claim migration);
5. ingress closure, global BullMQ pause, a ten-minute maximum active-job drain, then API/web stop;
6. schema-compatible template, ownership and worker-idle pre-migration audits, then one exact,
   quiesced DB/uploads pair in a unique deployment directory plus real restores into
   disposable targets and exact file-count/byte reconciliation;
7. live Redis RDB→AOF conversion when needed, a preserved immutable rollback-volume copy, target
   volume copy, then a read-only-source clone into a disposable Redis volume/container with strict
   truncated-AOF rejection and an exact bounded BullMQ aggregate comparison before cutover;
8. the verified forward-only boundary: Prisma migrations, then legacy queue-password conversion with CAS,
   then internal base Compose startup and API/web health waits; first install prompts once for an
   administrator through `scripts/bootstrap-admin.sh`;
9. strict ownership, production-readiness, attachment-storage and scanner audits, followed by queue
   resume only after every gate is green.

The Redis conversion follows the supported live-switch procedure; simply restarting an RDB-only
instance with AOF enabled can lose data. See the
[Redis persistence documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

Each Redis queue audit has its own 15-second operation timeout, so an unreachable Redis cannot turn
the outer drain deadline into an unbounded wait. Before the migration boundary, a failure attempts
to resume queues and restart the unchanged old internal release, but reports rollback success only
after old API/web health and queue resume are both proven. Otherwise it stays fail-closed with
ingress off. After the boundary, the trap stops the new API/web, leaves queues paused and edge traffic
off, and points to an owner-only recovery manifest containing the exact DB/uploads/Redis triplet and
old image IDs. The helper never mounts the rollback Redis volume into the disposable rehearsal,
never force-removes unknown containers and never runs `docker compose down -v`.

On first deployment there is no old data to back up. That is reported explicitly; any partial
project state instead aborts for manual inspection. The interactive administrator password exists
only in the one-shot process/container environment and is removed with that container.

Successful output ends with:

```text
Internal release is healthy and audited. No host ports or public edge were started.
```

Verify that statement:

```bash
export TELECOM_HD_WEB_BUILD_ID="$(./scripts/web-build-id.sh .env.prod)"
docker compose --profile scanner -f docker-compose.prod.yml \
  --env-file .env.prod ps
docker compose --profile scanner -f docker-compose.prod.yml \
  --env-file .env.prod logs --tail=150 api web postgres redis clamav
ss -lntup
```

### Inbound-mail migration/canary gate

The deploy helper's generic quiesce is necessary but does not prove an IMAP mailbox boundary.
Before enabling production queues after an inbound-ledger migration:

1. Keep all inbound workers/queues quiesced while the matching PostgreSQL + `uploads` (including
   `inbound-raw`) + Redis recovery triplet is backed up and restore-rehearsed.
2. Apply migrations forward only. Do not start an old API binary against an epoch/claim/reconcile
   schema, and do not invent a down migration.
3. Run the real PostgreSQL migration/upgrade rehearsal and the GreenMail/Dovecot matrix from
   `docs/INBOUND_LEDGER_VERIFICATION_RU.md`. A missing/red gate blocks queue enablement.
4. Configure exactly one non-customer-impacting canary mailbox/PIPE queue. Verify `/admin/mail`
   health: connection/poll/accepted stamps, epoch/generation, no unexplained alert, and raw-storage
   reserve. Deliver a controlled message, retry it, and inspect its ledger/audit outcome.
5. Only then enable the remaining queues one at a time. Stop immediately on a halted queue,
   transport/semantic collision, stale poll, quarantine growth, storage-reserve alert or unexpected
   ticket/post count. Preserve ledger/raw evidence; do not delete rows as a recovery shortcut.

## 5. HTTPS edge gate

`docker-compose.proxy.yml`, the Caddy file and nftables examples are reference components; the
internal deploy helper does **not** start them. Before any edge is enabled, document and verify:

- whether traffic reaches the origin directly, through Cloudflare proxy, or through a private
  tunnel;
- the exact trusted proxy hop count/ranges used to derive `req.ip`; caller-supplied forwarding
  headers must not be trusted from the open Internet;
- TLS mode and origin authentication, DNS, certificate issuance and canonical redirects;
- firewall allowlist: only the approved edge may reach origin ingress; management remains private;
- request-body limits, WAF/rate-limit rules and log redaction;
- a tested timed firewall rollback from a second management session;
- external port scan proving data-plane ports remain closed.

Do not use a blanket `nft flush ruleset`. Snapshot the exact current rules, install only the reviewed
delta with an automatic rollback, test the existing management session, then cancel the rollback.

Only after this gate may an operator explicitly start the reviewed edge override. There is no
generic command here because direct Caddy, Cloudflare and tunnel topologies require different
trusted-IP and firewall rules.

## 6. Mandatory HTTPS smoke

With edge access restricted to the release team, use a temporary real staff account:

```bash
export SMOKE_BASE_URL='https://real-helpdesk-host'
read -r -p 'Temporary smoke staff email: ' SMOKE_STAFF_EMAIL
read -r -s -p 'Temporary smoke staff password: ' SMOKE_STAFF_PASSWORD; echo
export SMOKE_STAFF_EMAIL SMOKE_STAFF_PASSWORD
bash scripts/smoke-prod.sh
unset SMOKE_STAFF_EMAIL SMOKE_STAFF_PASSWORD
```

The smoke verifies cookie-only login, signed CSRF, refresh rotation, `/auth/me`, logout and immediate
revocation. It rejects JWTs in JSON and never prints credentials, cookies, tokens or response bodies.

Also prove:

- production cookies are host-only `__Host-*`, `Secure`, and session cookies are `HttpOnly`;
- one controlled outbound mail passes SPF/DKIM/DMARC alignment;
- a client magic-link round trip works with an approved mailbox before enabling the portal;
- scanner signatures are fresh and a controlled EICAR upload is rejected before enabling uploads;
- external firewall/WAF checks and public rate-limit buckets use the real client IP.

## 7. Enable features in stages

After every stage: update `.env.prod`, rebuild/redeploy (the Turnstile site key is build-time and
therefore produces a new web build-digest tag), run preflight, repeat the relevant smoke, and keep
edge access restricted until green.

1. Staff-only; all four switches false.
2. `TELECOM_HD_CLIENT_PORTAL_ENABLED=true`; verify request-link, verify, session expiry and logout.
3. `TELECOM_HD_CLIENT_UPLOAD_ENABLED=true`; verify owner-bound claim/adoption and malware rejection.
4. `TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED=true`; verify action-bound Turnstile and the public
   department allowlist.
5. `TELECOM_HD_PUBLIC_UPLOAD_ENABLED=true`; verify request/byte quotas, storage reserve and EICAR.
6. Open the approved edge policy to the intended audience.

Turn the corresponding write switch off immediately on 429/403 spikes, mail abuse, scanner failure,
unexpected disk growth or unresolved storage reconciliation.

## 8. Rollback and common failures

This first security rollout is **forward-recovery or restore-triplet only** after the migration
boundary. Do not check out the previous commit and call its deploy script: that commit may not contain
the orchestrator and its Compose file may attach a different Redis volume.

On a post-boundary failure:

1. Keep ingress off and do not resume BullMQ. The failure trap stops API/web automatically.
2. Preserve logs and open the printed
   `backups/deploy-<timestamp>-<sha>/recovery-manifest.txt`; it contains no credentials but is mode
   `0600` because it is recovery provenance.
3. Prefer correcting the blocker and finishing forward with the current release.
4. If forward recovery is impossible, use the **current checkout's** helpers and `docs/BACKUP.md` to
   restore the exact database/uploads pair. The manifest's Redis rollback volume is the third member
   of that recovery point; do not attach, copy, delete or prune it without an attended recovery plan.
5. Recreate an older application only from the manifest's immutable old image IDs after the matching
   database and Redis state are restored. There is intentionally no generic destructive command:
   volume attachment and schema compatibility must be reviewed for that incident.

Never invent a down-migration, never restore only two members of the triplet, and never run
`docker compose down -v`. A normal previous-version application rollback may be automated only after
this release itself is the established known-good orchestrator and its migrations are proven backward
compatible.

Common fail-closed results:

- release mismatch or dirty checkout: deploy the exact clean commit;
- unknown/partial Compose state: inventory it manually; do not delete volumes;
- backup or restore rehearsal failure: repair backups before cutover;
- Redis AOF rewrite/restore mismatch: keep writers/edge off and inspect the copied volume;
- scanner timeout/stale signatures: keep every upload switch off;
- ownership/template/storage audit failure: correct data explicitly; do not bypass the audit;
- API/web health timeout after migrations: keep edge off and finish forward recovery;
- SMTP/Turnstile failure: keep the affected login/public feature closed.
