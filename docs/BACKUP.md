# Backup & Restore Runbook — 23 Telecom Help Desk

Covers: PostgreSQL database (`telecom_hd`) and the uploads file volume (`uploads`).

---

## Prerequisites

- Docker and Docker Compose installed on the prod host.
- `.env.prod` present and populated (all `TELECOM_HD_DB_*` vars set).
- Scripts are executable: `chmod +x scripts/db-backup.sh scripts/db-restore.sh`
- The production stack is running: `docker compose -f docker-compose.prod.yml --env-file .env.prod ps`

---

## 1. Taking a Database Backup

```bash
# One-shot backup (keeps last 14 dumps by default)
./scripts/db-backup.sh

# Keep last 30 dumps instead
./scripts/db-backup.sh --keep 30

# Write backups to a custom directory (e.g. a mounted NAS)
./scripts/db-backup.sh --backups-dir /mnt/nas/telecom-hd-backups
```

What the script does:

1. Sources `.env.prod` for `TELECOM_HD_DB_NAME` and `TELECOM_HD_DB_USER`.
2. Runs `pg_dump -Fc` inside the `postgres` container via `docker compose exec -T`.
3. Pipes output through `gzip` to `backups/<dbname>_<YYYYMMDDTHHMMSSz>.dump.gz`.
4. Deletes the oldest `.dump.gz` files beyond the keep limit.

Backup files are in **custom format** (`-Fc`), which is compressed and supports parallel restore.

---

## 2. Backing up the Uploads Volume

The `uploads` Docker volume (`telecom-hd-prod_uploads`) stores user-attached files. Back it up separately:

```bash
# Create a timestamped tar archive of the uploads volume
TIMESTAMP=$(date -u '+%Y%m%dT%H%M%SZ')
mkdir -p backups

docker run --rm \
  -v telecom-hd-prod_uploads:/data:ro \
  -v "$(pwd)/backups":/backup \
  busybox \
  tar czf "/backup/uploads_${TIMESTAMP}.tar.gz" -C /data .

echo "Uploads backup: backups/uploads_${TIMESTAMP}.tar.gz"
```

Retention: prune old tarballs the same way as DB dumps:

```bash
# Keep last 14 uploads backups
ls -1t backups/uploads_*.tar.gz | tail -n +15 | xargs -r rm -f
```

> **Offsite storage**: copy both `*.dump.gz` and `uploads_*.tar.gz` to an offsite location
> (S3, rclone, rsync to a remote host) after each backup run.

---

## 3. Scheduling Backups with Cron

Add to the crontab of the prod-server user (run `crontab -e`):

```cron
# Daily DB backup at 02:00 UTC, keep last 30
0 2 * * * /path/to/repo/scripts/db-backup.sh --keep 30 --backups-dir /mnt/nas/telecom-hd-backups >> /var/log/telecom-hd-backup.log 2>&1

# Daily uploads volume backup at 02:30 UTC
30 2 * * * TIMESTAMP=$(date -u '+\%Y\%m\%dT\%H\%M\%SZ') && \
  docker run --rm \
    -v telecom-hd-prod_uploads:/data:ro \
    -v /mnt/nas/telecom-hd-backups:/backup \
    busybox tar czf "/backup/uploads_${TIMESTAMP}.tar.gz" -C /data . \
  >> /var/log/telecom-hd-backup.log 2>&1
```

Adjust the path and `--backups-dir` to match the prod host layout.

Verify cron is running and logs are appearing:

```bash
tail -f /var/log/telecom-hd-backup.log
```

---

## 4. Restoring the Database

> **WARNING**: Restore OVERWRITES ALL DATA in the target database. Take a fresh backup first.

```bash
# List available backups
ls -lht backups/*.dump.gz

# Restore a specific dump
./scripts/db-restore.sh backups/telecom_hd_20260524T020001Z.dump.gz
```

The script will:

1. Print a clear warning and ask you to type `YES` to confirm.
2. Terminate active connections to the database.
3. Decompress the `.dump.gz` on the host and pipe it to `pg_restore --clean` inside the container.
4. Restore runs in a single transaction (`-1`): if it fails, the database is rolled back.

After restore, restart the API so Prisma reconnects cleanly:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod restart api
```

### Restoring the Uploads Volume

```bash
# Stop the API first to avoid writes during restore
docker compose -f docker-compose.prod.yml --env-file .env.prod stop api

# Clear the volume and restore
docker run --rm \
  -v telecom-hd-prod_uploads:/data \
  -v "$(pwd)/backups":/backup:ro \
  busybox \
  sh -c "rm -rf /data/* && tar xzf /backup/uploads_20260524T020031Z.tar.gz -C /data"

# Restart the API
docker compose -f docker-compose.prod.yml --env-file .env.prod start api
```

---

## 5. Testing a Restore (Staging / Dry-Run)

Never test a restore against the live prod database. Use a separate container:

```bash
# 1. Start a throwaway Postgres container
docker run -d --name pg-restore-test \
  -e POSTGRES_USER=telecom_hd \
  -e POSTGRES_PASSWORD=testpass \
  -e POSTGRES_DB=telecom_hd \
  postgres:16-alpine

# 2. Wait for it to be ready
docker exec pg-restore-test pg_isready -U telecom_hd

# 3. Restore the dump
gunzip -c backups/telecom_hd_20260524T020001Z.dump.gz \
  | docker exec -i pg-restore-test \
      pg_restore \
        -U telecom_hd \
        -d telecom_hd \
        --clean --if-exists --no-owner --no-acl -1 -Fc

# 4. Verify (see section 6)
docker exec -it pg-restore-test psql -U telecom_hd -d telecom_hd

# 5. Tear down
docker rm -f pg-restore-test
```

---

## 6. Verifying Backup Integrity

### Check the dump file is readable

```bash
# List table of contents without extracting (fast sanity check)
gunzip -c backups/telecom_hd_20260524T020001Z.dump.gz \
  | pg_restore --list -Fc | head -40
```

A healthy dump prints a table-of-contents with schema, table, and index entries. An empty or
corrupt file will produce an error immediately.

### Row-count spot-check after restore (inside the test container)

```bash
docker exec -it pg-restore-test psql -U telecom_hd -d telecom_hd -c "
  SELECT
    (SELECT count(*) FROM \"User\")      AS users,
    (SELECT count(*) FROM \"Ticket\")    AS tickets,
    (SELECT count(*) FROM \"Message\")   AS messages,
    (SELECT count(*) FROM \"Attachment\") AS attachments;
"
```

Compare these counts against known-good numbers from a recent prod query or the monitoring
dashboard. A restore that produces all-zero counts despite a recent active database is a red flag.

### Schema version check

```bash
docker exec -it pg-restore-test psql -U telecom_hd -d telecom_hd -c "
  SELECT migration_name, finished_at
  FROM \"_prisma_migrations\"
  ORDER BY finished_at DESC
  LIMIT 5;
"
```

The latest migration in the dump should match the latest migration currently in `apps/api/prisma/migrations/`.

---

## 7. Quick Reference

| Task                    | Command                                             |
| ----------------------- | --------------------------------------------------- |
| Take a backup now       | `./scripts/db-backup.sh`                            |
| Take a backup, keep 30  | `./scripts/db-backup.sh --keep 30`                  |
| List backups            | `ls -lht backups/*.dump.gz`                         |
| Restore a dump          | `./scripts/db-restore.sh backups/<file>.dump.gz`    |
| Backup uploads volume   | See section 2                                       |
| Restore uploads volume  | See section 4                                       |
| Verify dump readable    | `gunzip -c <file> \| pg_restore --list -Fc \| head` |
| Test restore (isolated) | See section 5                                       |
