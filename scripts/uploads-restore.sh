#!/usr/bin/env bash
# Restore an uploads archive into the production volume while every application
# writer remains stopped. Restore the matching database dump separately before
# bringing the release back online.
set -euo pipefail
umask 077

command -v flock >/dev/null 2>&1 || { echo 'ERROR: flock is required' >&2; exit 1; }
exec 9>"${TMPDIR:-/tmp}/telecom-hd-prod-ops.lock"
flock -n 9 || { echo 'ERROR: another deploy/backup/restore operation is running' >&2; exit 1; }
export TELECOM_HD_OPS_LOCK_HELD=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$REPO_ROOT"

ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env.prod}"
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="${REPO_ROOT}/${ENV_FILE}" ;;
esac
export TELECOM_HD_ENV_FILE="$ENV_FILE"
COMPOSE=(docker compose --profile scanner -f docker-compose.prod.yml --env-file "$ENV_FILE")

[[ $# -eq 1 ]] || { echo "Usage: $0 <uploads.tar.gz>" >&2; exit 1; }
ARCHIVE_FILE="$1"
[[ -f "$ARCHIVE_FILE" ]] || { echo 'ERROR: uploads archive not found' >&2; exit 1; }
ARCHIVE_FILE="$(cd "$(dirname "$ARCHIVE_FILE")" && pwd -P)/$(basename "$ARCHIVE_FILE")"
[[ -f "$ENV_FILE" ]] || { echo 'ERROR: .env.prod not found' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo 'ERROR: docker not found in PATH' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo 'ERROR: tar not found in PATH' >&2; exit 1; }
export TELECOM_HD_WEB_BUILD_ID="${TELECOM_HD_WEB_BUILD_ID:-$("${SCRIPT_DIR}/web-build-id.sh" "$ENV_FILE")}"

env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  value="${line#*=}"
  printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^['"'"'"]//; s/['"'"'"]$//'
}

RELEASE_ID="$(env_value TELECOM_HD_RELEASE)"
[[ -n "$RELEASE_ID" ]] || { echo 'ERROR: TELECOM_HD_RELEASE is required' >&2; exit 1; }
IMAGE="telecom-hd-api:${RELEASE_ID}"
docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "ERROR: immutable API image is not present: ${IMAGE}" >&2
  exit 1
}

"${SCRIPT_DIR}/validate-uploads-archive.sh" "$ARCHIVE_FILE"

UPLOADS_VERIFY_IMAGE="$IMAGE" scripts/uploads-verify-backup.sh "$ARCHIVE_FILE"

echo
echo '########################################################################'
echo '  WARNING: DESTRUCTIVE UPLOADS RESTORE'
echo "  Archive: ${ARCHIVE_FILE}"
echo '  The current production uploads volume will be replaced.'
echo '  API/web/known project edges will remain stopped after the restore.'
echo '########################################################################'
echo
read -r -p 'Type YES (all caps) to continue, anything else to abort: ' CONFIRM
[[ "$CONFIRM" == YES ]] || { echo 'Aborted — no changes made.' >&2; exit 1; }

echo '[uploads-restore] Stopping every known application writer and edge'
for service in caddy proxy api web; do
  ids="$(docker ps -q \
    --filter 'label=com.docker.compose.project=telecom-hd-prod' \
    --filter "label=com.docker.compose.service=${service}")"
  [[ -z "$ids" ]] || docker stop -t 30 $ids >/dev/null
done

echo '[uploads-restore] Taking a final safety archive of the current volume'
SAFETY_DIR="${REPO_ROOT}/backups/restore-safety-$(date -u '+%Y%m%dT%H%M%SZ')"
mkdir -p "$SAFETY_DIR"
chmod 700 "$SAFETY_DIR"
ENV_FILE="$ENV_FILE" scripts/uploads-backup.sh --keep 1 --backups-dir "$SAFETY_DIR"
[[ -f "$ARCHIVE_FILE" ]] || {
  echo 'ERROR: source archive disappeared before the destructive step; volume was not changed' >&2
  exit 1
}

echo '[uploads-restore] Clearing the uploads volume'
"${COMPOSE[@]}" run --rm --no-deps -T --user 0 --entrypoint sh api -ec \
  'find /app/uploads -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'

echo '[uploads-restore] Extracting the verified archive'
gunzip -c "$ARCHIVE_FILE" | "${COMPOSE[@]}" run --rm --no-deps -T \
  --user 0 --entrypoint tar api xf - -C /app/uploads
"${COMPOSE[@]}" run --rm --no-deps -T --user 0 --entrypoint chown api \
  -R node:node /app/uploads

echo '[uploads-restore] Restore complete. Services remain stopped.'
echo '[uploads-restore] Restore/verify the matching database, run the attachment audit, then start services explicitly.'
