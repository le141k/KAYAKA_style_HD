#!/usr/bin/env bash
# Archive the production uploads volume through a one-off container using the
# immutable API image. The main API may (and for a consistent backup pair should)
# be stopped while this runs.
# Usage: ./scripts/uploads-backup.sh [--keep N] [--backups-dir DIR]
set -euo pipefail
umask 077

if [[ "${TELECOM_HD_OPS_LOCK_HELD:-0}" != 1 ]]; then
  command -v flock >/dev/null 2>&1 || { echo 'ERROR: flock is required' >&2; exit 1; }
  exec 9>"${TMPDIR:-/tmp}/telecom-hd-prod-ops.lock"
  flock -n 9 || { echo 'ERROR: another deploy/backup/restore operation is running' >&2; exit 1; }
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.prod}"
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="${REPO_ROOT}/${ENV_FILE}" ;;
esac
export TELECOM_HD_ENV_FILE="$ENV_FILE"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
BACKUPS_DIR="${REPO_ROOT}/backups"
KEEP=14

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2 ;;
    --backups-dir) BACKUPS_DIR="$2"; shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done

[[ "$KEEP" =~ ^[1-9][0-9]*$ ]] || { echo 'ERROR: --keep must be a positive integer' >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo 'ERROR: .env.prod not found' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker not found in PATH' >&2; exit 1; }
export TELECOM_HD_WEB_BUILD_ID="${TELECOM_HD_WEB_BUILD_ID:-$("${SCRIPT_DIR}/web-build-id.sh" "$ENV_FILE")}"

mkdir -p "$BACKUPS_DIR"
chmod 700 "$BACKUPS_DIR"
TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
ARCHIVE_FILE="${BACKUPS_DIR}/uploads_${TIMESTAMP}.tar.gz"
PARTIAL_FILE="${ARCHIVE_FILE}.partial.$$"
trap 'rm -f "${PARTIAL_FILE:-}"' EXIT HUP INT TERM

echo "[uploads-backup] Archiving the uploads volume"
docker compose \
  --profile scanner \
  -f "$COMPOSE_FILE" \
  --env-file "$ENV_FILE" \
  run --rm --no-deps -T --entrypoint tar api \
  czf - -C /app/uploads . > "$PARTIAL_FILE"

chmod 600 "$PARTIAL_FILE"
mv "$PARTIAL_FILE" "$ARCHIVE_FILE"
trap - EXIT HUP INT TERM
echo "[uploads-backup] Done — ${ARCHIVE_FILE} ($(du -sh "$ARCHIVE_FILE" | cut -f1))"

shopt -s nullglob
BACKUP_FILES=("$BACKUPS_DIR"/uploads_*.tar.gz)
shopt -u nullglob
BACKUP_COUNT="${#BACKUP_FILES[@]}"
if [[ "$BACKUP_COUNT" -gt "$KEEP" ]]; then
  PRUNE_COUNT=$((BACKUP_COUNT - KEEP))
  for ((i = 0; i < PRUNE_COUNT; i++)); do
    rm -f -- "${BACKUP_FILES[$i]}"
  done
  echo "[uploads-backup] Pruned ${PRUNE_COUNT} old archive(s)."
fi
