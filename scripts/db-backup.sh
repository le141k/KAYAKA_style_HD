#!/usr/bin/env bash
# scripts/db-backup.sh — pg_dump the prod Postgres DB in custom format, gzip, prune old files.
#
# Usage:
#   ./scripts/db-backup.sh [--keep N] [--backups-dir /path/to/backups]
#
# Environment (read from .env.prod unless already exported):
#   TELECOM_HD_DB_NAME   — defaults to telecom_hd
#   TELECOM_HD_DB_USER   — defaults to telecom_hd
#
# Options:
#   --keep N          Keep the N most recent backups (default: 14)
#   --backups-dir D   Directory to write backups (default: ./backups)
#
# Make executable: chmod +x scripts/db-backup.sh

set -euo pipefail
umask 077

if [[ "${TELECOM_HD_OPS_LOCK_HELD:-0}" != 1 ]]; then
  command -v flock >/dev/null 2>&1 || { echo 'ERROR: flock is required' >&2; exit 1; }
  exec 9>"${TMPDIR:-/tmp}/telecom-hd-prod-ops.lock"
  flock -n 9 || { echo 'ERROR: another deploy/backup/restore operation is running' >&2; exit 1; }
fi

# ── Defaults ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.prod}"
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="${REPO_ROOT}/${ENV_FILE}" ;;
esac
export TELECOM_HD_ENV_FILE="$ENV_FILE"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
KEEP=14
BACKUPS_DIR="${REPO_ROOT}/backups"

# ── Argument parsing ─────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)        KEEP="$2";        shift 2 ;;
    --backups-dir) BACKUPS_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  value="${line#*=}"
  printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^['"'"'"]//; s/['"'"'"]$//'
}

# Read only the two required keys; never execute the env file as shell code.
DB_NAME="${TELECOM_HD_DB_NAME:-$(env_value TELECOM_HD_DB_NAME)}"
DB_USER="${TELECOM_HD_DB_USER:-$(env_value TELECOM_HD_DB_USER)}"
DB_NAME="${DB_NAME:-telecom_hd}"
DB_USER="${DB_USER:-telecom_hd}"

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found in PATH" >&2; exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "ERROR: ${COMPOSE_FILE} not found" >&2; exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: ${ENV_FILE} not found" >&2; exit 1
fi
export TELECOM_HD_WEB_BUILD_ID="${TELECOM_HD_WEB_BUILD_ID:-$("${SCRIPT_DIR}/web-build-id.sh" "$ENV_FILE")}"

if [[ ! "${KEEP}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: --keep must be a positive integer" >&2; exit 1
fi

if [[ ! "${DB_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "ERROR: TELECOM_HD_DB_NAME contains unsupported characters" >&2; exit 1
fi

if [[ ! "${DB_USER}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "ERROR: TELECOM_HD_DB_USER contains unsupported characters" >&2; exit 1
fi

# ── Prepare backups directory ────────────────────────────────────────────────
mkdir -p "${BACKUPS_DIR}"
chmod 700 "${BACKUPS_DIR}"

TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DUMP_FILE="${BACKUPS_DIR}/${DB_NAME}_${TIMESTAMP}.dump.gz"
PARTIAL_FILE="${DUMP_FILE}.partial.$$"
trap 'rm -f "${PARTIAL_FILE:-}"' EXIT HUP INT TERM

echo "[db-backup] Starting backup of '${DB_NAME}' (user: ${DB_USER})"
echo "[db-backup] Target: ${DUMP_FILE}"

# ── pg_dump (custom format -Fc) piped through gzip ───────────────────────────
# -T: no pseudo-TTY (required for piping)
# Compose supplies the validated production environment to the Postgres container.
docker compose \
  --profile scanner \
  -f "${COMPOSE_FILE}" \
  --env-file "${ENV_FILE}" \
  exec -T postgres \
  pg_dump \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    -Fc \
    --no-password \
  | gzip > "${PARTIAL_FILE}"

chmod 600 "${PARTIAL_FILE}"
mv "${PARTIAL_FILE}" "${DUMP_FILE}"
trap - EXIT HUP INT TERM

DUMP_SIZE="$(du -sh "${DUMP_FILE}" | cut -f1)"
echo "[db-backup] Done — ${DUMP_FILE} (${DUMP_SIZE})"

# ── Retention: keep only the N most recent .dump.gz files ────────────────────
echo "[db-backup] Pruning old backups (keeping last ${KEEP})..."
shopt -s nullglob
BACKUP_FILES=("${BACKUPS_DIR}/${DB_NAME}_"*.dump.gz)
shopt -u nullglob
BACKUP_COUNT="${#BACKUP_FILES[@]}"

if [[ "${BACKUP_COUNT}" -gt "${KEEP}" ]]; then
  PRUNE_COUNT=$(( BACKUP_COUNT - KEEP ))
  for ((i = 0; i < PRUNE_COUNT; i++)); do
    rm -f -- "${BACKUP_FILES[$i]}"
  done
  echo "[db-backup] Pruned ${PRUNE_COUNT} old backup(s)."
else
  echo "[db-backup] No pruning needed (${BACKUP_COUNT} backup(s) present, limit ${KEEP})."
fi

echo "[db-backup] Finished."
