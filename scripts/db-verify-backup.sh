#!/usr/bin/env bash
# Restore a production dump into a disposable PostgreSQL container and verify it.
set -euo pipefail
umask 077

if [[ "${TELECOM_HD_OPS_LOCK_HELD:-0}" != 1 ]]; then
  command -v flock >/dev/null 2>&1 || { echo 'ERROR: flock is required' >&2; exit 1; }
  exec 9>"${TMPDIR:-/tmp}/telecom-hd-prod-ops.lock"
  flock -n 9 || { echo 'ERROR: another deploy/backup/restore operation is running' >&2; exit 1; }
fi

[[ $# -eq 1 ]] || { echo "Usage: $0 <backup.dump.gz>" >&2; exit 1; }
DUMP_FILE="$1"
[[ -f "$DUMP_FILE" ]] || { echo "ERROR: backup not found" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker not found' >&2; exit 1; }
gzip -t "$DUMP_FILE"

IMAGE="${POSTGRES_VERIFY_IMAGE:-postgres:16.14-alpine3.23}"
CONTAINER="telecom-hd-db-restore-check-$$"
PASSWORD="restore-check-${RANDOM}-${RANDOM}"
cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM

echo '[db-verify] Starting disposable restore target'
docker run -d \
  --name "$CONTAINER" \
  -e POSTGRES_USER=restore_check \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB=restore_check \
  "$IMAGE" >/dev/null

ready=false
for _attempt in $(seq 1 90); do
  if docker exec "$CONTAINER" pg_isready -U restore_check -d restore_check >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'ERROR: disposable PostgreSQL did not become ready' >&2; exit 1; }

echo '[db-verify] Restoring dump in one transaction'
gunzip -c "$DUMP_FILE" | docker exec -i "$CONTAINER" pg_restore \
  -U restore_check \
  -d restore_check \
  --no-owner \
  --no-acl \
  --exit-on-error \
  -1 \
  -Fc

MIGRATION_COUNT="$(
  docker exec "$CONTAINER" psql -U restore_check -d restore_check -Atc \
    'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;'
)"
[[ "$MIGRATION_COUNT" =~ ^[1-9][0-9]*$ ]] || {
  echo 'ERROR: restored database has no completed migration history' >&2
  exit 1
}
echo "[db-verify] Restore verified (${MIGRATION_COUNT} completed migrations)"
