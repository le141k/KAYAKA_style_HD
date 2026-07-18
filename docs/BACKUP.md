# Backup and restore runbook — 23 Telecom Help Desk

PostgreSQL and the `uploads` volume form one application-data recovery pair. A deployment rollback
also needs the matching Redis/BullMQ snapshot recorded by `scripts/deploy-prod.sh`; treat the three
artifacts as one triplet because queued external side effects must not be separated from DB state.

## Prerequisites

- run from the clean production checkout with owner-only `.env.prod`;
- Docker Engine, Docker Compose and `flock` installed;
- the immutable API image named by `TELECOM_HD_RELEASE` already built;
- backup destination mounted, encrypted and writable only by the production operator;
- scripts executable:

```bash
chmod +x scripts/web-build-id.sh scripts/validate-uploads-archive.sh \
  scripts/db-backup.sh scripts/db-verify-backup.sh scripts/db-restore.sh \
  scripts/uploads-backup.sh scripts/uploads-verify-backup.sh scripts/uploads-restore.sh
```

Every helper uses the same non-blocking host lock, `umask 077`, partial files and atomic rename.
Never run two deploy/backup/restore operations concurrently.

## Take a consistent backup pair

First close ingress and stop every application writer. The exact edge command depends on the
approved topology; the base production Compose file intentionally has no public edge.

```bash
export TELECOM_HD_WEB_BUILD_ID="$(./scripts/web-build-id.sh .env.prod)"
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod stop -t 30 api web
./scripts/db-backup.sh --keep 30 --backups-dir /mnt/backup/telecom-hd
./scripts/uploads-backup.sh --keep 30 --backups-dir /mnt/backup/telecom-hd
```

`db-backup.sh` runs `pg_dump -Fc` and writes
`<dbname>_<UTC timestamp>.dump.gz`. `uploads-backup.sh` uses a one-off container from the immutable,
unprivileged API image and writes `uploads_<UTC timestamp>.tar.gz`; it does not depend on the main
API container being online.

Record the two exact filenames as a pair. Copy both off-host before a migration or destructive
operator action. A database dump and uploads archive taken while writes continue can each be valid
but are not guaranteed to agree with each other.

The internal deploy helper performs this quiescence, backup and restore proof automatically for an
existing release.

## Prove both backups are restorable

Do not test a restore against production. The verification helpers create disposable targets and
remove them on exit:

```bash
POSTGRES_VERIFY_IMAGE=postgres:16.14-alpine3.23 \
  ./scripts/db-verify-backup.sh /mnt/backup/telecom-hd/telecom_hd_<timestamp>.dump.gz

UPLOADS_VERIFY_IMAGE='telecom-hd-api:REPLACE_WITH_TELECOM_HD_RELEASE' \
  ./scripts/uploads-verify-backup.sh /mnt/backup/telecom-hd/uploads_<timestamp>.tar.gz
```

The database proof performs a real single-transaction `pg_restore` and requires completed Prisma
migration history. The uploads proof checks gzip/tar readability, extracts into a disposable Docker
volume and inventories the restored regular files. `scripts/validate-uploads-archive.sh` rejects
absolute/traversal paths, links and special files before any target volume is touched. A successful
command is necessary but does not replace offsite-copy monitoring or periodic recovery drills.

## Restore a matched pair or deployment triplet

Restore is destructive and must be an attended maintenance operation. Keep management access that
does not depend on the application edge. Close ingress first and keep all writers stopped.

For a routine DB/uploads recovery, verify both artifacts with the commands above. For a failed
deployment, first read the owner-only `recovery-manifest.txt` from its unique deployment backup
directory and keep BullMQ paused. Do not restore only DB/uploads while allowing a post-cutover Redis
queue to run; finish forward or plan restoration of the manifest's preserved Redis rollback volume
and old image IDs as described in `docs/DEPLOY.md`.

1. Verify both file artifacts with the commands above.
2. Restore the database:

   ```bash
   ./scripts/db-restore.sh /mnt/backup/telecom-hd/telecom_hd_<timestamp>.dump.gz
   ```

3. Restore the uploads volume:

   ```bash
   ./scripts/uploads-restore.sh /mnt/backup/telecom-hd/uploads_<timestamp>.tar.gz
   ```

Both destructive helpers require typing `YES`. The uploads helper rejects traversal, links and
special files, proves the archive in a disposable volume, stops known project writers/edges, takes
one last safety archive, restores ownership, and deliberately leaves services stopped.

After both restores, start only the internal stack and verify it before reopening any edge:

```bash
export TELECOM_HD_WEB_BUILD_ID="$(./scripts/web-build-id.sh .env.prod)"
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod up -d --no-build
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod exec -T api \
  node dist/seed/audit-user-email-ownership.js
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod exec -T api \
  node dist/seed/audit-attachment-storage.js
docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod exec -T api \
  node dist/seed/audit-production-readiness.js
```

Check API/web/database/scanner health and the expected migration version, user/ticket/post counts,
attachment aggregate counts/bytes and a representative owner-scoped download. Reopening the edge is
a separate decision.

Deployment recovery is fail-closed. Before the migration boundary, `deploy-prod.sh` reopens the old
internal release only after it proves old API/web health and BullMQ resume. After the boundary it
stops the new writers, keeps queues paused and ingress closed, and requires forward recovery or the
exact manifest-recorded DB/uploads/Redis triplet. Its Redis restore rehearsal copies the candidate
volume into a disposable clone, starts a disposable Redis with strict truncated-AOF rejection and
compares the bounded aggregate BullMQ snapshot; it never tests by mounting the rollback volume
read-write.

## Scheduled backups

Use an absolute repository path and an off-host destination. Stagger the two jobs only if business
accepts that they are not a transactionally consistent pair; the preferred scheduled job briefly
quiesces writers and runs both helpers under the shared operations lock.

Example for independent daily archives:

```cron
0 2 * * * /srv/telecom-hd/scripts/db-backup.sh --keep 30 --backups-dir /mnt/backup/telecom-hd >> /var/log/telecom-hd-backup.log 2>&1
30 2 * * * /srv/telecom-hd/scripts/uploads-backup.sh --keep 30 --backups-dir /mnt/backup/telecom-hd >> /var/log/telecom-hd-backup.log 2>&1
```

Alert on a missing/zero-size artifact, helper failure, offsite-copy failure, retention failure and a
restore rehearsal that has not succeeded within the agreed recovery-test interval. Never put
database passwords or the rendered Compose configuration in backup logs.
