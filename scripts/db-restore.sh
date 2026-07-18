#!/usr/bin/env bash
# scripts/db-restore.sh — restore a pg_dump custom-format (.dump.gz) into the prod DB.
#
# WARNING: This DROPS and re-creates all objects in the target database.
#          All existing data will be OVERWRITTEN. Take a fresh backup first.
#
# Usage:
#   ./scripts/db-restore.sh <dump-file.dump.gz>
#
# Environment (read from .env.prod unless already exported):
#   TELECOM_HD_DB_NAME   — defaults to telecom_hd
#   TELECOM_HD_DB_USER   — defaults to telecom_hd
#
# Make executable: chmod +x scripts/db-restore.sh

set -euo pipefail
umask 077

if [[ "${TELECOM_HD_OPS_LOCK_HELD:-0}" != 1 ]]; then
  command -v flock >/dev/null 2>&1 || { echo 'ERROR: flock is required' >&2; exit 1; }
  exec 9>"${TMPDIR:-/tmp}/telecom-hd-prod-ops.lock"
  flock -n 9 || { echo 'ERROR: another deploy/backup/restore operation is running' >&2; exit 1; }
fi

# ── Defaults ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.prod}"
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="${REPO_ROOT}/${ENV_FILE}" ;;
esac
export TELECOM_HD_ENV_FILE="$ENV_FILE"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"

# ── Argument: dump file ───────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <dump-file.dump.gz>" >&2
  echo ""
  echo "Available backups in ${REPO_ROOT}/backups/:"
  ls -1t "${REPO_ROOT}/backups/"*.dump.gz 2>/dev/null || echo "  (none found)"
  exit 1
fi

DUMP_FILE="$1"

if [[ ! -f "${DUMP_FILE}" ]]; then
  echo "ERROR: dump file not found: ${DUMP_FILE}" >&2; exit 1
fi

env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  value="${line#*=}"
  printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^['"'"'"]//; s/['"'"'"]$//'
}

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

if [[ ! "${DB_NAME}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "ERROR: TELECOM_HD_DB_NAME contains unsupported characters" >&2; exit 1
fi

if [[ ! "${DB_USER}" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
  echo "ERROR: TELECOM_HD_DB_USER contains unsupported characters" >&2; exit 1
fi

# ── Confirmation prompt ───────────────────────────────────────────────────────
echo ""
echo "########################################################################"
echo "  WARNING: DESTRUCTIVE OPERATION"
echo ""
echo "  This will restore:"
echo "    File : ${DUMP_FILE}"
echo "    Into : ${DB_NAME} (user: ${DB_USER})"
echo ""
echo "  ALL EXISTING DATA IN '${DB_NAME}' WILL BE OVERWRITTEN."
echo "  There is no undo. Take a fresh backup first if you haven't already."
echo "########################################################################"
echo ""
read -r -p "Type YES (all caps) to continue, anything else to abort: " CONFIRM

if [[ "${CONFIRM}" != "YES" ]]; then
  echo "Aborted — no changes made." >&2; exit 1
fi

echo ""
echo "[db-restore] Restoring '${DB_NAME}' from: ${DUMP_FILE}"

# Keep the application quiesced for the entire destructive restore. Starting it
# again is an explicit post-restore verification step below.
echo "[db-restore] Stopping API writers..."
docker compose \
  --profile scanner \
  -f "${COMPOSE_FILE}" \
  --env-file "${ENV_FILE}" \
  stop -t 30 api

# ── Terminate active connections so pg_restore can drop/recreate objects ──────
echo "[db-restore] Terminating existing connections to '${DB_NAME}'..."
docker compose \
  --profile scanner \
  -f "${COMPOSE_FILE}" \
  --env-file "${ENV_FILE}" \
  exec -T postgres \
  psql \
    -U "${DB_USER}" \
    -d postgres \
    -c "SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();" \
  > /dev/null

# ── pg_restore: decompress on the host, pipe into the container ───────────────
# --clean : drop objects before recreating (idempotent restore)
# --if-exists : suppress errors if an object to drop does not exist
# --no-owner : do not set ownership (avoids role-not-found errors)
# --no-acl   : skip GRANT/REVOKE (privileges often differ between envs)
# -1 (single transaction): all-or-nothing; rolls back on error
echo "[db-restore] Running pg_restore..."
gunzip -c "${DUMP_FILE}" \
  | docker compose \
      --profile scanner \
      -f "${COMPOSE_FILE}" \
      --env-file "${ENV_FILE}" \
      exec -T postgres \
      pg_restore \
        -U "${DB_USER}" \
        -d "${DB_NAME}" \
        --clean \
        --if-exists \
        --no-owner \
        --no-acl \
        -1 \
        -Fc

echo "[db-restore] Restore complete."
echo ""
echo "Next steps:"
echo "  1. Verify the restore (row counts / migration version) — see docs/BACKUP.md"
echo "  2. Restart API containers if needed:"
echo "       export TELECOM_HD_WEB_BUILD_ID=\$(./scripts/web-build-id.sh .env.prod)"
echo "       docker compose --profile scanner -f docker-compose.prod.yml --env-file .env.prod restart api"
