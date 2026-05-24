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

# ── Defaults ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env.prod"
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

# ── Load .env.prod if present (values already in env take precedence) ────────
if [[ -f "${ENV_FILE}" ]]; then
  # Use `set -a` + source so values with spaces/special chars aren't mangled (xargs breaks on quotes).
  set -a
  # shellcheck disable=SC1090
  . "${ENV_FILE}"
  set +a
fi

DB_NAME="${TELECOM_HD_DB_NAME:-telecom_hd}"
DB_USER="${TELECOM_HD_DB_USER:-telecom_hd}"

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "ERROR: docker not found in PATH" >&2; exit 1
fi

if [[ ! -f "${COMPOSE_FILE}" ]]; then
  echo "ERROR: ${COMPOSE_FILE} not found" >&2; exit 1
fi

# ── Prepare backups directory ────────────────────────────────────────────────
mkdir -p "${BACKUPS_DIR}"

TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
DUMP_FILE="${BACKUPS_DIR}/${DB_NAME}_${TIMESTAMP}.dump.gz"

echo "[db-backup] Starting backup of '${DB_NAME}' (user: ${DB_USER})"
echo "[db-backup] Target: ${DUMP_FILE}"

# ── pg_dump (custom format -Fc) piped through gzip ───────────────────────────
# -T: no pseudo-TTY (required for piping)
# PGPASSWORD is passed through the environment sourced from .env.prod above.
docker compose \
  -f "${COMPOSE_FILE}" \
  --env-file "${ENV_FILE}" \
  exec -T postgres \
  pg_dump \
    -U "${DB_USER}" \
    -d "${DB_NAME}" \
    -Fc \
    --no-password \
  | gzip > "${DUMP_FILE}"

DUMP_SIZE="$(du -sh "${DUMP_FILE}" | cut -f1)"
echo "[db-backup] Done — ${DUMP_FILE} (${DUMP_SIZE})"

# ── Retention: keep only the N most recent .dump.gz files ────────────────────
echo "[db-backup] Pruning old backups (keeping last ${KEEP})..."
BACKUP_COUNT="$(find "${BACKUPS_DIR}" -maxdepth 1 -name "*.dump.gz" | wc -l | tr -d ' ')"

if [[ "${BACKUP_COUNT}" -gt "${KEEP}" ]]; then
  PRUNE_COUNT=$(( BACKUP_COUNT - KEEP ))
  find "${BACKUPS_DIR}" -maxdepth 1 -name "*.dump.gz" \
    | sort \
    | head -n "${PRUNE_COUNT}" \
    | xargs rm -f
  echo "[db-backup] Pruned ${PRUNE_COUNT} old backup(s)."
else
  echo "[db-backup] No pruning needed (${BACKUP_COUNT} backup(s) present, limit ${KEEP})."
fi

echo "[db-backup] Finished."
