# Production Deployment Runbook — 23 Telecom Help Desk

> Follow top-to-bottom on a fresh server. Every step is required; none are optional unless
> explicitly marked. Commands are written for a Debian/Ubuntu host running as a non-root user
> with `sudo` access.

---

## 1. Prerequisites

| Requirement           | Minimum                        | Notes                                               |
| --------------------- | ------------------------------ | --------------------------------------------------- |
| Docker Engine         | 26+                            | `docker --version`                                  |
| Docker Compose plugin | v2.24+                         | `docker compose version` (no hyphen)                |
| RAM                   | 2 GB                           | 512 MB reserved per container × 2 + OS overhead     |
| Disk                  | 10 GB free                     | images + Postgres data + uploads volume + backups   |
| Domain name           | A record pointing at server IP | e.g. `help.example.com`                             |
| DNS A record          | Propagated before first run    | Caddy uses HTTP-01 ACME; port 80 must be reachable  |
| Firewall ports        | 80, 443 open inbound           | Caddy handles both; nothing else needs to be public |

Postgres (5432) and Redis (6379) are **internal-only** in the prod compose — they are never published to the host.

Install Docker if needed:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # then log out and back in
```

---

## 2. Clone and Checkout

```bash
git clone <repo-url> telecom-hd
cd telecom-hd
git checkout main
```

Confirm you are on the right commit:

```bash
git log --oneline -3
```

---

## 3. Fill `.env.prod`

### 3a. Copy the template

```bash
cp .env.prod.example .env.prod
chmod 600 .env.prod    # restrict to owner only
$EDITOR .env.prod
```

### 3b. Variable reference

Fill **every** variable. The API refuses to boot if any secret retains a placeholder value
(see `apps/api/src/config/configuration.ts` — `assertProductionSecrets`). Patterns rejected:
`change-me`, `dev-secret`, `placeholder`, `example`, `changeme`, four or more zeros.

#### Generate strong secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run this command once per secret below.

| Variable                              | Type                      | Notes                                                                                                                                                                                             |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                            | fixed                     | Set to `production` — do not change                                                                                                                                                               |
| `TELECOM_HD_PUBLIC_URL`               | **operator-supplied**     | Full public URL, e.g. `https://help.example.com` — no trailing slash                                                                                                                              |
| `NEXT_PUBLIC_API_URL`                 | **operator-supplied**     | Same value as `TELECOM_HD_PUBLIC_URL`; baked into the web image at build time — changing it later requires a rebuild                                                                              |
| `TELECOM_HD_DB_USER`                  | operator-supplied         | Postgres username, e.g. `telecom_hd`                                                                                                                                                              |
| `TELECOM_HD_DB_PASSWORD`              | **auto-generated secret** | Strong random string; stored in `pgdata` volume                                                                                                                                                   |
| `TELECOM_HD_DB_NAME`                  | operator-supplied         | Postgres database name, e.g. `telecom_hd`                                                                                                                                                         |
| `TELECOM_HD_REDIS_PASSWORD`           | **auto-generated secret** | Redis requires a password in prod; used in both the `redis` service and `REDIS_URL`                                                                                                               |
| `TELECOM_HD_JWT_ACCESS_SECRET`        | **auto-generated secret** | Min 32 chars; must differ from the refresh secret                                                                                                                                                 |
| `TELECOM_HD_JWT_REFRESH_SECRET`       | **auto-generated secret** | Min 32 chars; must differ from the access secret                                                                                                                                                  |
| `TELECOM_HD_JWT_ACCESS_TTL`           | operator-supplied         | Access token TTL in seconds; default `900` (15 min)                                                                                                                                               |
| `TELECOM_HD_JWT_REFRESH_TTL`          | operator-supplied         | Refresh token TTL in seconds; default `2592000` (30 days)                                                                                                                                         |
| `TELECOM_HD_SMTP_HOST`                | **operator-supplied**     | Real SMTP relay hostname (e.g. `smtp.sendgrid.net`); NOT MailHog                                                                                                                                  |
| `TELECOM_HD_SMTP_PORT`                | **operator-supplied**     | Typically `587` (STARTTLS) or `465` (TLS)                                                                                                                                                         |
| `TELECOM_HD_SMTP_SECURE`              | **operator-supplied**     | `true` for STARTTLS/TLS; `false` only if the relay requires it                                                                                                                                    |
| `TELECOM_HD_SMTP_USER`                | **operator-supplied**     | SMTP auth username (e.g. `apikey` for SendGrid)                                                                                                                                                   |
| `TELECOM_HD_SMTP_PASSWORD`            | **operator-supplied**     | SMTP auth password / API key                                                                                                                                                                      |
| `TELECOM_HD_MAIL_FROM`                | **operator-supplied**     | Sender display name + address; must pass SPF/DKIM on your domain                                                                                                                                  |
| `TELECOM_HD_ALARIS_WEBHOOK_SECRET`    | **auto-generated secret** | Shared secret for `POST /api/alaris/webhook`; min 32 chars; the shipped default `alaris-dev-secret-change-me-0000` is explicitly rejected at boot                                                 |
| `TELECOM_HD_INBOUND_WEBHOOK_SECRET`   | **auto-generated secret** | Shared secret for `POST /api/inbound/pipe` (MTA/PIPE mail ingress); min 32 chars; the shipped dev default is rejected at boot — **set it even if you only use IMAP**, or the API refuses to start |
| `TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL`    | **operator-supplied**     | Email for the first admin account created on first boot                                                                                                                                           |
| `TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD` | **operator-supplied**     | Strong password for the bootstrap admin; never use `demo1234`                                                                                                                                     |
| `TELECOM_HD_FIELD_ENCRYPTION_KEY`     | optional                  | 64 hex chars (256-bit AES key) for IMAP password field encryption; omit if not using IMAP polling                                                                                                 |
| `TELECOM_HD_LOG_LEVEL`                | operator-supplied         | `info` for production; `debug` only for troubleshooting                                                                                                                                           |
| `TELECOM_HD_UPLOAD_DIR`               | fixed                     | `/app/uploads` — mapped to the `uploads` named volume; do not change                                                                                                                              |
| `TELECOM_HD_UPLOAD_MAX_SIZE_MB`       | operator-supplied         | File upload cap; default `25`                                                                                                                                                                     |

> `TELECOM_HD_SEED=1` is intentionally absent from `.env.prod.example`. Do not set it — it
> creates the known-password demo admin (`admin@23telecom.example` / `demo1234`), which is a
> security risk in production.

### 3c. Validate with preflight

Run the preflight validator — it checks for unfilled `<<<` placeholders, required keys,
secret strength, `https://` URLs, the 64-hex field key, and a non-default admin password,
mirroring the server-side `assertProductionSecrets()` guard. It prints only key names (never
values) and exits non-zero on any failure:

```bash
bash scripts/preflight.sh .env.prod
# All [✓] and exit 0 → ready. Any [✗] → fix before deploying.
```

---

## 4. TLS / Reverse Proxy (Caddy)

The prod compose does **not** handle TLS internally. Caddy terminates HTTPS and proxies to
`api:4000` and `web:3000` over the internal Docker network.

The Caddyfile is at `infra/caddy/Caddyfile`. It:

- Routes `/api/*` to the API container on port 4000.
- Routes everything else to the web container on port 3000.
- Sets HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`.
- Handles gzip/zstd encoding and enforces a 25 MB upload limit.
- Obtains and renews Let's Encrypt certificates automatically via HTTP-01 (requires port 80 to
  be publicly reachable before first start).

### 4a. Create the Caddy override compose file

```bash
cat > docker-compose.proxy.yml << 'EOF'
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./infra/caddy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
      - telecom-hd-prod_default

volumes:
  caddy_data:
  caddy_config:
EOF
```

### 4b. Set the DOMAIN in `.env.prod`

Add to `.env.prod`:

```
DOMAIN=help.example.com
```

The Caddyfile reads `{$DOMAIN}` from the environment.

> Cookie note: Caddy forwards `Set-Cookie` and `Cookie` headers untouched. The API sets
> `HttpOnly + Secure` session cookies — do not add header transforms that strip them.

---

## 5. Build and Launch

```bash
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.proxy.yml \
  --env-file .env.prod \
  up -d --build
```

### What happens on first boot

The `api` container runs three steps before starting NestJS:

```
npx prisma migrate deploy   # applies all pending migrations to Postgres
node dist/seed/bootstrap-admin.js   # creates admin StaffGroup + staff account (idempotent)
node dist/main.js           # starts the NestJS app on :4000
```

`bootstrap-admin.js` reads `TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL` and
`TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD`. If either is unset it logs a warning and skips silently
(does not crash). On subsequent boots it is a no-op — it never resets a password that was
already set.

The `web` container waits for the `api` healthcheck to pass before starting.

### Monitor startup

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=50
```

Expected final lines:

```
api  | [bootstrap-admin] StaffGroup "Administrator" already exists ...
api  | [Nest] ... Application is running on: http://[::]:4000
web  | ... ready started server on 0.0.0.0:3000
```

### Service memory limits

| Service    | Reserved   | Limit      |
| ---------- | ---------- | ---------- |
| `api`      | 256 MB     | 512 MB     |
| `web`      | 256 MB     | 512 MB     |
| `postgres` | OS default | OS default |
| `redis`    | OS default | OS default |

---

## 6. First-Run Verification

Run each check in order. All must pass before declaring the deployment live.

### 6a. API health endpoint

```bash
curl -f https://help.example.com/api/health
# Expected: {"status":"ok","db":"up","redis":"up"} with HTTP 200
```

### 6b. Log in as the bootstrap admin

1. Open `https://help.example.com/staff` in a browser.
2. Sign in with `TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL` / `TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD`.
3. Confirm the staff dashboard loads.

### 6c. Submit a public ticket

```bash
curl -fsS -X POST https://help.example.com/api/tickets/public \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Deploy test","requesterEmail":"ops@example.com","requesterName":"Ops","contents":"First prod ticket"}'
# Expected: JSON body with a "mask" field (ticket reference)
```

Confirm the ticket appears in the staff queue at `/staff/tickets`.

### 6d. Confirm SMTP delivery

1. In the staff UI, reply to the test ticket from step 6c.
2. Check the inbox for `ops@example.com` (or your test address).
3. If no email arrives within 2 minutes, check the API logs:

```bash
docker compose -f docker-compose.prod.yml logs api | grep -i smtp
```

### 6e. Run the smoke suite against prod (optional but recommended)

```bash
API_URL=https://help.example.com \
TELECOM_HD_ALARIS_WEBHOOK_SECRET=<your-alaris-secret> \
bash scripts/smoke.sh
```

The smoke script verifies: OpenAPI served, staff login, public ticket creation, Alaris webhook
ticket creation. All four checks must print `✓`.

---

## 7. Day-2 Operations

### 7a. Database backups

`scripts/db-backup.sh` runs `pg_dump` inside the running `postgres` container, pipes through
`gzip`, and stores files under `./backups/`. It reads credentials from `.env.prod` automatically.

```bash
chmod +x scripts/db-backup.sh

# Manual backup
./scripts/db-backup.sh

# With options
./scripts/db-backup.sh --keep 30 --backups-dir /var/backups/telecom-hd
```

Files are named `telecom_hd_<timestamp>.dump.gz` in custom pg_dump format. Default retention is
14 files.

Schedule daily backups with cron:

```bash
crontab -e
# Add:
0 2 * * * cd /path/to/telecom-hd && ./scripts/db-backup.sh --keep 14 >> /var/log/telecom-hd-backup.log 2>&1
```

Restore from backup:

```bash
# Find the backup file
ls backups/

# Restore with the helper (WARNING: overwrites the current DB; prompts for YES).
# It gunzips the .dump.gz and runs pg_restore in a single transaction — do NOT pipe
# the .gz straight into pg_restore (it cannot read gzip).
bash scripts/db-restore.sh backups/telecom_hd_<timestamp>.dump.gz
```

Copy backups off-server to object storage (S3, GCS, Backblaze) regularly.

### 7b. Log rotation

All containers use the `json-file` driver with `max-size: 10m` and `max-file: 5` (capped at
50 MB per service). This is configured in `docker-compose.prod.yml` and requires no additional
setup. To view logs:

```bash
docker compose -f docker-compose.prod.yml logs -f --tail=100 api
docker compose -f docker-compose.prod.yml logs -f --tail=100 web
```

### 7c. Updating (pull + rebuild + migrate)

```bash
git pull origin main

# Rebuild and restart (migrations run automatically at api boot)
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.proxy.yml \
  --env-file .env.prod \
  up -d --build
```

The `api` container runs `prisma migrate deploy` on every start — migrations are applied before
the app accepts traffic. Downtime is typically 10–30 seconds while images rebuild and containers
restart.

### 7d. Rollback

If a deployment introduces a regression:

```bash
# Find the previous commit
git log --oneline -5

# Check out the last known-good tag or commit
git checkout <previous-commit>

# Rebuild and restart
docker compose \
  -f docker-compose.prod.yml \
  -f docker-compose.proxy.yml \
  --env-file .env.prod \
  up -d --build
```

If the new migration is destructive and needs reverting, restore from backup (section 7a) before
rolling back the code. Prisma does not support automatic down-migrations.

---

## 8. Troubleshooting

### API refuses to start — insecure secrets

**Symptom:** Container exits immediately; logs show:

```
Refusing to start in production with insecure secrets:
  - TELECOM_HD_JWT_ACCESS_SECRET: must be a strong non-default value in production
```

**Fix:** `assertProductionSecrets` in `apps/api/src/config/configuration.ts` blocks boot when
any secret matches the placeholder pattern (`change-me`, `dev-secret`, `example`, `0000`, etc.)
or when the two JWT secrets are identical. Generate fresh values and update `.env.prod`.

Rejected values include (but are not limited to): any string containing `change-me`,
`dev-secret`, `placeholder`, `example`, `changeme`, or four or more consecutive zeros.

### Redis authentication failure

**Symptom:** API logs show `NOAUTH Authentication required` or BullMQ workers fail to connect.

**Cause:** The Redis container requires a password set via `TELECOM_HD_REDIS_PASSWORD` in
`.env.prod`. The `REDIS_URL` in the compose file is built as
`redis://:${TELECOM_HD_REDIS_PASSWORD}@redis:6379`. If the variable is missing or mismatched,
Redis rejects all connections.

**Fix:** Ensure `TELECOM_HD_REDIS_PASSWORD` is set and identical in `.env.prod`. Restart both
`redis` and `api` after any change:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod restart redis api
```

### `NEXT_PUBLIC_API_URL` points to wrong host

**Symptom:** Browser console shows API calls going to `localhost:4000` or a stale domain.

**Cause:** `NEXT_PUBLIC_API_URL` is baked into the Next.js bundle at image build time. Setting it
in runtime environment has no effect. This is a Next.js constraint documented in
`apps/web/Dockerfile`.

**Fix:** Update `NEXT_PUBLIC_API_URL` in `.env.prod` and rebuild the `web` image:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.proxy.yml \
  --env-file .env.prod up -d --build web
```

### Migrations fail at boot

**Symptom:** `api` container exits with `Error: P3009` or similar Prisma migration error.

**Fix:**

```bash
# Check migration status inside the running postgres container
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec postgres psql -U telecom_hd -d telecom_hd \
  -c "SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 10;"
```

If a migration is marked failed, resolve the underlying cause (usually a schema conflict from a
manual DB change) before restarting.

### Caddy cannot obtain TLS certificate

**Symptom:** Caddy logs show `ACME challenge failed` or `no A/AAAA records found`.

**Fix:**

- Confirm the DNS A record for your domain resolves to the server's public IP:
  `dig +short help.example.com`
- Confirm ports 80 and 443 are open: `curl -v http://help.example.com`
- On first run, Caddy needs a few seconds to issue the certificate. Check:
  `docker compose -f docker-compose.proxy.yml logs caddy`

### Bootstrap admin was not created

**Symptom:** Cannot log in to `/staff` because no staff account exists.

**Cause:** `TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL` or `TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD` was
missing from `.env.prod` on first boot. The script logs a warning and exits 0 (does not fail
the boot).

**Fix:** Add both variables to `.env.prod` and restart the api container. The script is
idempotent — it creates the account if the email is not already in the database, and skips
silently if it is.

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod restart api
docker compose -f docker-compose.prod.yml logs api | grep bootstrap
```

### Uploads volume not writable

**Symptom:** File attachment uploads return 500 errors; API logs show `EACCES /app/uploads`.

**Cause:** The `uploads` named volume may be owned by root if it was created before the `node`
user chown in the Dockerfile.

**Fix:**

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod \
  exec -u root api chown -R node:node /app/uploads
```

---

## Known Caveats

- **Alaris admin page is a stub.** The "Alaris Integration" tab in the admin UI shows a
  "Coming soon" thresholds form that is non-functional (see `docs/adr/0005-alaris-stub.md`).
  The webhook endpoint (`POST /api/alaris/webhook`) is fully functional for receiving events.
- **SLA calculations are UTC-based.** There is no timezone-aware business-hours calendar.
  SLA breach times are computed in UTC regardless of the operator's local timezone.
- **No CI/CD pipeline.** There is no GitHub Actions workflow. All gates (`make verify`) run
  locally only. Run `make verify` before every production update.
- **Demo seed must not be enabled in production.** `TELECOM_HD_SEED=1` creates
  `admin@23telecom.example` with the public password `demo1234`. Never set this variable in
  `.env.prod`.
