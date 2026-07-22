#!/usr/bin/env bash
# Safe internal-only production deployment. This script deliberately starts no
# host-published edge; HTTPS ingress is a separate, explicitly approved gate.
set -euo pipefail
umask 077

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-.env.prod}"
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="$PWD/$ENV_FILE" ;;
esac
export TELECOM_HD_ENV_FILE="$ENV_FILE"

PROJECT_NAME=telecom-hd-prod
REDIS_DATA_VOLUME=telecom-hd-prod-redisdata
REDIS_IMAGE=redis:7.4.8-alpine
POSTGRES_IMAGE=postgres:16.14-alpine3.23
COMPOSE=(docker compose --profile scanner -f docker-compose.prod.yml --env-file "$ENV_FILE")

command -v flock >/dev/null 2>&1 || { echo '[deploy-prod] ERROR: flock is required' >&2; exit 1; }
exec 9>"${TMPDIR:-/tmp}/telecom-hd-prod-ops.lock"
flock -n 9 || { echo '[deploy-prod] ERROR: another deploy/backup operation holds the lock' >&2; exit 1; }
export TELECOM_HD_OPS_LOCK_HELD=1

env_value() {
  local key="$1" line value
  line="$(grep -E "^${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
  value="${line#*=}"
  printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^['"'"'"]//; s/['"'"'"]$//'
}

service_ids() {
  docker ps -aq \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1"
}

running_service_ids() {
  docker ps -q \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --filter "label=com.docker.compose.service=$1"
}

require_single_id() {
  local service="$1" ids="$2" count
  count="$(printf '%s\n' "$ids" | sed '/^$/d' | wc -l | tr -d ' ')"
  if (( count > 1 )); then
    echo "[deploy-prod] ERROR: multiple ${service} containers found for project ${PROJECT_NAME}" >&2
    exit 1
  fi
}

require_healthy() {
  local service="$1" id="$2" status
  [[ -n "$id" ]] || { echo "[deploy-prod] ERROR: existing ${service} container is missing" >&2; exit 1; }
  status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$id")"
  [[ "$status" == healthy ]] || {
    echo "[deploy-prod] ERROR: existing ${service} is not healthy (status=${status})" >&2
    exit 1
  }
}

wait_healthy() {
  local id="$1" service="$2" attempts="${3:-90}" status
  [[ -n "$id" ]] || return 1
  for _attempt in $(seq 1 "$attempts"); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)"
    [[ "$status" == healthy || "$status" == running ]] && return 0
    [[ "$status" == exited || "$status" == dead ]] && return 1
    sleep 1
  done
  echo "[deploy-prod] ERROR: ${service} did not become healthy" >&2
  return 1
}

echo '[deploy-prod] 1/12 validating configuration, host capacity and release identity'
bash scripts/preflight.sh "$ENV_FILE"

case "$(uname -m)" in
  x86_64|amd64) ;;
  *) echo '[deploy-prod] ERROR: the pinned ClamAV image requires x86_64/amd64' >&2; exit 1 ;;
esac

if [[ "$(uname -s)" == Linux ]]; then
  MEMORY_KB="$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)"
  SWAP_KB="$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)"
  AVAILABLE_KB="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  SWAP_FREE_KB="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)"
  if (( MEMORY_KB + SWAP_KB < 8 * 1024 * 1024 )); then
    echo '[deploy-prod] ERROR: at least 8 GiB RAM+swap is required for scanner plus image builds' >&2
    exit 1
  fi
  if (( AVAILABLE_KB + SWAP_FREE_KB < 4 * 1024 * 1024 )); then
    echo '[deploy-prod] ERROR: at least 4 GiB currently available RAM+swap is required' >&2
    exit 1
  fi
fi

FREE_DISK_KB="$(df -Pk "$PWD" | awk 'NR == 2 {print $4}')"
if (( FREE_DISK_KB < 15 * 1024 * 1024 )); then
  echo '[deploy-prod] ERROR: at least 15 GiB free disk is required for build and restore rehearsal' >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
  echo '[deploy-prod] ERROR: working-tree changes present; deploy a clean release checkout' >&2
  exit 1
fi
CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ "$CURRENT_BRANCH" == main ]] || {
  echo '[deploy-prod] ERROR: production checkout must be on branch main' >&2
  exit 1
}
echo '[deploy-prod] Fetching origin/main for a current release-provenance check'
git fetch --quiet origin main
GIT_SHA="$(git rev-parse HEAD)"
ORIGIN_MAIN_SHA="$(git rev-parse refs/remotes/origin/main 2>/dev/null || true)"
[[ -n "$ORIGIN_MAIN_SHA" && "$GIT_SHA" == "$ORIGIN_MAIN_SHA" ]] || {
  echo '[deploy-prod] ERROR: HEAD must exactly match the fetched origin/main release' >&2
  echo '[deploy-prod] Run: git fetch origin main && git switch main && git pull --ff-only origin main' >&2
  exit 1
}
RELEASE_ID="$(env_value TELECOM_HD_RELEASE)"
case "$GIT_SHA" in
  "$RELEASE_ID"*) ;;
  *) echo '[deploy-prod] ERROR: TELECOM_HD_RELEASE does not identify this checkout' >&2; exit 1 ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  CHECKSUM_CMD=(sha256sum)
else
  CHECKSUM_CMD=(shasum -a 256)
fi
PUBLIC_CONFIG_CHECKSUM="$({
  for key in TELECOM_HD_RELEASE DOMAIN TELECOM_HD_PUBLIC_URL NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY TELECOM_HD_CLIENT_PORTAL_ENABLED \
    TELECOM_HD_CLIENT_UPLOAD_ENABLED \
    TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED TELECOM_HD_PUBLIC_UPLOAD_ENABLED \
    TELECOM_HD_UPLOAD_MAX_SIZE_MB TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB \
    TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB TELECOM_HD_INBOUND_MAX_SIZE_MB \
    TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT \
    TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB \
    TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS \
    TELECOM_HD_CLAMAV_ENABLED \
    TELECOM_HD_CLAMAV_HOST TELECOM_HD_CLAMAV_PORT; do
    printf '%s=%s\n' "$key" "$(env_value "$key")"
  done
} | "${CHECKSUM_CMD[@]}" | awk '{print $1}')"
WEB_BUILD_CHECKSUM="$(scripts/web-build-id.sh --full "$ENV_FILE")"
export TELECOM_HD_WEB_BUILD_ID="${WEB_BUILD_CHECKSUM:0:16}"
echo "[deploy-prod] release=${RELEASE_ID} public-config-sha256=${PUBLIC_CONFIG_CHECKSUM} web-build=${TELECOM_HD_WEB_BUILD_ID}"

echo '[deploy-prod] validating the production dependency audit before any Docker or ingress action'
npm audit --package-lock-only --omit=dev --omit=optional --audit-level=high

echo '[deploy-prod] 2/12 inventorying the existing dedicated Compose project'
PROJECT_SERVICES="$(
  docker ps -a --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --format '{{.Label "com.docker.compose.service"}}' | sort -u
)"
while IFS= read -r service; do
  [[ -z "$service" ]] && continue
  case "$service" in
    postgres|redis|clamav|api|web|caddy|proxy) ;;
    *) echo "[deploy-prod] ERROR: unknown project sidecar '${service}'; inspect it manually" >&2; exit 1 ;;
  esac
done <<< "$PROJECT_SERVICES"

POSTGRES_ID="$(service_ids postgres)"
REDIS_ID="$(service_ids redis)"
API_ID="$(service_ids api)"
WEB_ID="$(service_ids web)"
CADDY_ID="$(service_ids caddy)"
PROXY_ID="$(service_ids proxy)"
CLAMAV_ID="$(service_ids clamav)"
for pair in "postgres:$POSTGRES_ID" "redis:$REDIS_ID" "api:$API_ID" "web:$WEB_ID" \
  "caddy:$CADDY_ID" "proxy:$PROXY_ID" "clamav:$CLAMAV_ID"; do
  require_single_id "${pair%%:*}" "${pair#*:}"
done

EXISTING_RELEASE=false
OLD_API_IMAGE_ID=''
OLD_API_IMAGE_REF=''
OLD_WEB_IMAGE_ID=''
OLD_WEB_IMAGE_REF=''
if [[ -n "$POSTGRES_ID" ]]; then
  EXISTING_RELEASE=true
  require_healthy postgres "$POSTGRES_ID"
  require_healthy redis "$REDIS_ID"
  require_healthy api "$API_ID"
  require_healthy web "$WEB_ID"
  OLD_API_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$API_ID")"
  OLD_API_IMAGE_REF="$(docker inspect --format '{{.Config.Image}}' "$API_ID")"
  OLD_WEB_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$WEB_ID")"
  OLD_WEB_IMAGE_REF="$(docker inspect --format '{{.Config.Image}}' "$WEB_ID")"
else
  EXISTING_VOLUMES="$(docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}")"
  NAMED_REDIS_VOLUME=''
  if docker volume inspect "$REDIS_DATA_VOLUME" >/dev/null 2>&1; then
    NAMED_REDIS_VOLUME="$REDIS_DATA_VOLUME"
  fi
  if [[ -n "$EXISTING_VOLUMES$NAMED_REDIS_VOLUME$REDIS_ID$API_ID$WEB_ID$CADDY_ID$PROXY_ID$CLAMAV_ID" ]]; then
    echo '[deploy-prod] ERROR: partial project state exists without a Postgres container; inspect manually' >&2
    exit 1
  fi
  echo '[deploy-prod] No existing project state: first internal deployment.'
fi

echo '[deploy-prod] 3/12 pulling pinned runtime images while the old release remains online'
"${COMPOSE[@]}" pull postgres redis clamav

echo '[deploy-prod] 4/12 building immutable API/web images while the old release remains online'
"${COMPOSE[@]}" build --pull api web

QUIESCED=false
ROLL_FORWARD=false
REDIS_VERIFY_CONTAINER=''
REDIS_VERIFY_VOLUME=''
QUEUES_PAUSED=false
RECOVERY_MANIFEST=''
restore_old_release() {
  local status=$?
  trap - EXIT HUP INT TERM
  [[ -n "$REDIS_VERIFY_CONTAINER" ]] && docker rm -f "$REDIS_VERIFY_CONTAINER" >/dev/null 2>&1 || true
  [[ -n "$REDIS_VERIFY_VOLUME" ]] && docker volume rm -f "$REDIS_VERIFY_VOLUME" >/dev/null 2>&1 || true
  if [[ "$QUIESCED" == true && "$ROLL_FORWARD" == false ]]; then
    echo '[deploy-prod] Pre-boundary failure: attempting a fail-closed internal rollback.' >&2
    ROLLBACK_READY=true
    if [[ -n "$REDIS_ID" ]]; then
      if ! docker start "$REDIS_ID" >/dev/null 2>&1 || ! wait_healthy "$REDIS_ID" redis 90; then
        ROLLBACK_READY=false
        echo '[deploy-prod] ERROR: old Redis could not be restored healthy.' >&2
      fi
    fi
    if [[ "$ROLLBACK_READY" == true && "$QUEUES_PAUSED" == true ]]; then
      if "${COMPOSE[@]}" run --rm --no-deps -T api \
        node dist/seed/audit-redis-cutover.js --resume; then
        QUEUES_PAUSED=false
      else
        ROLLBACK_READY=false
        echo '[deploy-prod] ERROR: BullMQ queues could not be proved resumed.' >&2
      fi
    fi
    if [[ "$ROLLBACK_READY" == true && -n "$API_ID" ]]; then
      docker start "$API_ID" >/dev/null 2>&1 || ROLLBACK_READY=false
      [[ "$ROLLBACK_READY" == false ]] || wait_healthy "$API_ID" api 180 || ROLLBACK_READY=false
    fi
    if [[ "$ROLLBACK_READY" == true && -n "$WEB_ID" ]]; then
      docker start "$WEB_ID" >/dev/null 2>&1 || ROLLBACK_READY=false
      [[ "$ROLLBACK_READY" == false ]] || wait_healthy "$WEB_ID" web 120 || ROLLBACK_READY=false
    fi
    if [[ "$ROLLBACK_READY" == false ]]; then
      [[ -z "$API_ID" ]] || docker stop -t 30 "$API_ID" >/dev/null 2>&1 || true
      [[ -z "$WEB_ID" ]] || docker stop -t 30 "$WEB_ID" >/dev/null 2>&1 || true
      echo '[deploy-prod] Old application remains stopped; recover manually from the management session.' >&2
    else
      echo '[deploy-prod] Old internal API/web are healthy; queues are resumed.' >&2
    fi
    echo '[deploy-prod] Edge remains stopped after every failed deployment.' >&2
  elif [[ "$ROLL_FORWARD" == true ]]; then
    echo '[deploy-prod] Post-boundary failure: freezing every new application writer; edge stays off.' >&2
    PAUSED_FOR_FAILURE=false
    for _attempt in $(seq 1 12); do
      if "${COMPOSE[@]}" exec -T api node dist/seed/audit-redis-cutover.js --pause >/dev/null 2>&1; then
        PAUSED_FOR_FAILURE=true
        QUEUES_PAUSED=true
        break
      fi
      sleep 5
    done
    "${COMPOSE[@]}" stop -t 30 api web >/dev/null 2>&1 || true
    if [[ "$PAUSED_FOR_FAILURE" == false ]]; then
      if "${COMPOSE[@]}" run --rm --no-deps -T api \
        node dist/seed/audit-redis-cutover.js --pause >/dev/null 2>&1; then
        QUEUES_PAUSED=true
      else
        echo '[deploy-prod] WARNING: queues could not be proved paused; keep Redis isolated.' >&2
      fi
    fi
    for service in caddy proxy; do
      EDGE_IDS="$(docker ps -q \
        --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
        --filter "label=com.docker.compose.service=${service}")"
      [[ -z "$EDGE_IDS" ]] || docker stop -t 30 $EDGE_IDS >/dev/null 2>&1 || true
    done
    [[ -z "$RECOVERY_MANIFEST" ]] || \
      echo "[deploy-prod] Recovery metadata: ${RECOVERY_MANIFEST}" >&2
    echo '[deploy-prod] Keep queues paused. Inspect logs and finish forward or restore the recorded recovery triplet.' >&2
  fi
  exit "$status"
}
trap restore_old_release EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

DB_BACKUP=''
UPLOADS_BACKUP=''
UPLOADS_EXPECTED_FILES=0
UPLOADS_EXPECTED_BYTES=0
REDIS_KEYS_BEFORE=0
REDIS_QUEUE_SNAPSHOT=''
if [[ "$EXISTING_RELEASE" == true ]]; then
  echo '[deploy-prod] 5/12 closing ingress, pausing queues, and draining active workers'
  for id in "$CADDY_ID" "$PROXY_ID"; do
    [[ -n "$id" ]] && docker stop -t 30 "$id" >/dev/null
  done
  QUIESCED=true

  # Pause globally while the old API is alive, then wait for every current job
  # to finish. Killing a long-running mail/SLA/report job after 30 seconds could
  # duplicate an external side effect on retry.
  QUEUES_PAUSED=true
  WORKERS_IDLE=false
  for _attempt in $(seq 1 120); do
    if REDIS_QUEUE_SNAPSHOT="$(
      "${COMPOSE[@]}" run --rm --no-deps -T api \
        node dist/seed/audit-redis-cutover.js --pause --snapshot
    )"; then
      WORKERS_IDLE=true
      break
    fi
    sleep 5
  done
  [[ "$WORKERS_IDLE" == true && -n "$REDIS_QUEUE_SNAPSHOT" ]] || {
    echo '[deploy-prod] ERROR: BullMQ workers did not drain within 10 minutes' >&2
    exit 1
  }

  [[ -n "$API_ID" ]] && docker stop -t 90 "$API_ID" >/dev/null
  [[ -n "$WEB_ID" ]] && docker stop -t 30 "$WEB_ID" >/dev/null

  # Paused queues may still receive jobs from API-side IMAP/repeatable producers.
  # Once the old API is fully stopped, capture the authoritative persisted state
  # used by the manifest and disposable Redis comparison.
  REDIS_QUEUE_SNAPSHOT="$(
    "${COMPOSE[@]}" run --rm --no-deps -T api \
      node dist/seed/audit-redis-cutover.js --pause --snapshot
  )"
  [[ -n "$REDIS_QUEUE_SNAPSHOT" ]] || {
    echo '[deploy-prod] ERROR: final BullMQ snapshot is empty' >&2
    exit 1
  }

  echo '[deploy-prod] 6/12 validating queue field encryption, then running pre-migration audits'
  # The old API is stopped and every BullMQ queue is paused at this point. Convert
  # legacy plaintext IMAP passwords with CAS semantics before the new production
  # runtime enforces its encryption key. The seed prints aggregate counts only;
  # any malformed ciphertext, wrong key, or unstable direct DB edit aborts before
  # migrations/the forward-only boundary and triggers the old-release rollback.
  "${COMPOSE[@]}" run --rm --no-deps -T api \
    node dist/seed/reencrypt-email-queue-passwords.js
  "${COMPOSE[@]}" run --rm --no-deps -T api node dist/seed/audit-pre-migration.js
  "${COMPOSE[@]}" run --rm --no-deps -T api \
    node dist/seed/audit-user-email-ownership.js --pre-migration

  UPLOADS_SOURCE_INVENTORY="$(
    "${COMPOSE[@]}" run --rm --no-deps -T --entrypoint sh api -ec \
      "find /app/uploads -type f -exec stat -c %s {} + | awk '{ files += 1; bytes += \$1 } END { printf \"%d %d\", files, bytes }'"
  )"
  read -r UPLOADS_EXPECTED_FILES UPLOADS_EXPECTED_BYTES <<< "$UPLOADS_SOURCE_INVENTORY"
  [[ "$UPLOADS_EXPECTED_FILES" =~ ^[0-9]+$ && "$UPLOADS_EXPECTED_BYTES" =~ ^[0-9]+$ ]] || {
    echo '[deploy-prod] ERROR: live uploads inventory failed' >&2
    exit 1
  }

  echo '[deploy-prod] 7/12 taking a quiesced DB/uploads pair and proving both restores'
  DEPLOY_STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
  DEPLOY_BACKUP_DIR="$PWD/backups/deploy-${DEPLOY_STAMP}-${GIT_SHA:0:12}"
  [[ ! -e "$DEPLOY_BACKUP_DIR" ]] || {
    echo '[deploy-prod] ERROR: unique deployment backup directory already exists' >&2
    exit 1
  }
  mkdir -p "$DEPLOY_BACKUP_DIR"
  chmod 700 "$DEPLOY_BACKUP_DIR"
  ENV_FILE="$ENV_FILE" scripts/db-backup.sh --keep 1 --backups-dir "$DEPLOY_BACKUP_DIR"
  ENV_FILE="$ENV_FILE" scripts/uploads-backup.sh --keep 1 --backups-dir "$DEPLOY_BACKUP_DIR"
  DB_NAME="$(env_value TELECOM_HD_DB_NAME)"
  shopt -s nullglob
  DB_BACKUPS=("$DEPLOY_BACKUP_DIR/${DB_NAME}_"*.dump.gz)
  UPLOAD_BACKUPS=("$DEPLOY_BACKUP_DIR/uploads_"*.tar.gz)
  shopt -u nullglob
  (( ${#DB_BACKUPS[@]} == 1 && ${#UPLOAD_BACKUPS[@]} == 1 )) || {
    echo '[deploy-prod] ERROR: backup helpers did not produce one exact rollback pair' >&2
    exit 1
  }
  DB_BACKUP="${DB_BACKUPS[0]}"
  UPLOADS_BACKUP="${UPLOAD_BACKUPS[0]}"
  POSTGRES_VERIFY_IMAGE="$POSTGRES_IMAGE" scripts/db-verify-backup.sh "$DB_BACKUP"
  UPLOADS_VERIFY_IMAGE="telecom-hd-api:${RELEASE_ID}" \
    UPLOADS_EXPECTED_FILES="$UPLOADS_EXPECTED_FILES" \
    UPLOADS_EXPECTED_BYTES="$UPLOADS_EXPECTED_BYTES" \
    scripts/uploads-verify-backup.sh "$UPLOADS_BACKUP"

  echo '[deploy-prod] 8/12 snapshotting and migrating Redis data to the durable named volume'
  REDIS_PASSWORD="$(env_value TELECOM_HD_REDIS_PASSWORD)"
  # Redis explicitly requires an RDB-only instance to enable AOF while it is
  # still live, then finish the initial rewrite before restart. Merely copying
  # dump.rdb and booting with appendonly=yes can start from an empty AOF.
  OLD_APPENDONLY="$(
    docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_ID" \
      redis-cli --no-auth-warning --raw CONFIG GET appendonly | tail -1 | tr -d '\r'
  )"
  if [[ "$OLD_APPENDONLY" != yes ]]; then
    docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_ID" \
      redis-cli --no-auth-warning CONFIG SET appendonly yes >/dev/null
  fi

  AOF_READY=false
  for _attempt in $(seq 1 300); do
    REDIS_PERSISTENCE="$(
      docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_ID" \
        redis-cli --no-auth-warning --raw INFO persistence | tr -d '\r'
    )"
    AOF_ENABLED="$(printf '%s\n' "$REDIS_PERSISTENCE" | awk -F: '$1 == "aof_enabled" {print $2}')"
    AOF_RUNNING="$(printf '%s\n' "$REDIS_PERSISTENCE" | awk -F: '$1 == "aof_rewrite_in_progress" {print $2}')"
    AOF_SCHEDULED="$(printf '%s\n' "$REDIS_PERSISTENCE" | awk -F: '$1 == "aof_rewrite_scheduled" {print $2}')"
    AOF_STATUS="$(printf '%s\n' "$REDIS_PERSISTENCE" | awk -F: '$1 == "aof_last_bgrewrite_status" {print $2}')"
    AOF_WRITE_STATUS="$(printf '%s\n' "$REDIS_PERSISTENCE" | awk -F: '$1 == "aof_last_write_status" {print $2}')"
    AOF_BUFFER_LENGTH="$(printf '%s\n' "$REDIS_PERSISTENCE" | awk -F: '$1 == "aof_buffer_length" {print $2}')"
    AOF_PENDING_FSYNC="$(printf '%s\n' "$REDIS_PERSISTENCE" | awk -F: '$1 == "aof_pending_bio_fsync" {print $2}')"
    if [[ "$AOF_ENABLED" == 1 && "$AOF_RUNNING" == 0 && "$AOF_SCHEDULED" == 0 && \
      "$AOF_STATUS" == ok && "$AOF_WRITE_STATUS" == ok && "$AOF_BUFFER_LENGTH" == 0 && \
      "$AOF_PENDING_FSYNC" == 0 ]]; then
      AOF_READY=true
      break
    fi
    sleep 1
  done
  [[ "$AOF_READY" == true ]] || {
    echo '[deploy-prod] ERROR: Redis AOF rewrite/write/fsync state did not become durable' >&2
    exit 1
  }

  # WAITAOF tracks writes made by the same connection. Write and delete a
  # non-secret marker through one redis-cli session so its acknowledged fsync
  # necessarily covers every earlier AOF record on this single Redis instance.
  AOF_MARKER="telecom-hd:deploy-fsync:${DEPLOY_STAMP}:${GIT_SHA:0:12}"
  WAITAOF_OUTPUT="$(
    printf 'SET %s 1\nDEL %s\nWAITAOF 1 0 5000\n' "$AOF_MARKER" "$AOF_MARKER" \
      | docker exec -i -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_ID" \
          redis-cli --no-auth-warning --raw
  )"
  WAITAOF_LOCAL="$(printf '%s\n' "$WAITAOF_OUTPUT" | tail -2 | head -1)"
  [[ "$WAITAOF_LOCAL" =~ ^[0-9]+$ && "$WAITAOF_LOCAL" -ge 1 ]] || {
    echo '[deploy-prod] ERROR: Redis did not acknowledge a local AOF fsync' >&2
    exit 1
  }

  docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_ID" \
    redis-cli --no-auth-warning SAVE >/dev/null
  REDIS_KEYS_BEFORE="$(
    docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_ID" \
      redis-cli --no-auth-warning --raw DBSIZE
  )"
  REDIS_MOUNT="$(
    docker inspect --format \
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Type}}|{{.Name}}{{end}}{{end}}' \
      "$REDIS_ID"
  )"
  [[ "$REDIS_MOUNT" == volume\|* && -n "${REDIS_MOUNT#volume|}" ]] || {
    echo '[deploy-prod] ERROR: Redis /data is not a Docker volume; migrate it manually' >&2
    exit 1
  }
  OLD_REDIS_VOLUME="${REDIS_MOUNT#volume|}"
  docker stop -t 30 "$REDIS_ID" >/dev/null

  REDIS_ROLLBACK_VOLUME="${PROJECT_NAME}-redis-rollback-${DEPLOY_STAMP}-${GIT_SHA:0:12}"
  if docker volume inspect "$REDIS_ROLLBACK_VOLUME" >/dev/null 2>&1; then
    echo '[deploy-prod] ERROR: unique Redis rollback volume already exists' >&2
    exit 1
  fi
  docker volume create \
    --label 'com.23telecom.helpdesk.rollback=true' \
    --label "com.23telecom.helpdesk.release=${GIT_SHA}" \
    "$REDIS_ROLLBACK_VOLUME" >/dev/null
  docker run --rm --user 0 \
    -v "$OLD_REDIS_VOLUME:/from:ro" \
    -v "$REDIS_ROLLBACK_VOLUME:/to" \
    "$REDIS_IMAGE" \
    sh -ec 'cp -a /from/. /to/ && chown -R redis:redis /to && { test ! -f /to/dump.rdb || redis-check-rdb /to/dump.rdb >/dev/null; }'

  if [[ "$OLD_REDIS_VOLUME" != "$REDIS_DATA_VOLUME" ]]; then
    if docker volume inspect "$REDIS_DATA_VOLUME" >/dev/null 2>&1; then
      if ! docker run --rm --user 0 -v "$REDIS_DATA_VOLUME:/to:ro" "$REDIS_IMAGE" \
        sh -ec 'test -z "$(find /to -mindepth 1 -maxdepth 1 -print -quit)"'; then
        echo '[deploy-prod] ERROR: target Redis volume is non-empty; inspect before cutover' >&2
        exit 1
      fi
    else
      docker volume create \
        --label "com.docker.compose.project=${PROJECT_NAME}" \
        --label 'com.docker.compose.volume=redisdata' \
        "$REDIS_DATA_VOLUME" >/dev/null
    fi
    docker run --rm --user 0 \
      -v "$REDIS_ROLLBACK_VOLUME:/from:ro" \
      -v "$REDIS_DATA_VOLUME:/to" \
      "$REDIS_IMAGE" \
      sh -ec 'cp -a /from/. /to/ && chown -R redis:redis /to && { test ! -f /to/dump.rdb || redis-check-rdb /to/dump.rdb >/dev/null; }'
  fi

  RECOVERY_MANIFEST="$DEPLOY_BACKUP_DIR/recovery-manifest.txt"
  {
    printf 'created_utc=%s\n' "$DEPLOY_STAMP"
    printf 'target_release=%s\n' "$GIT_SHA"
    printf 'public_config_sha256=%s\n' "$PUBLIC_CONFIG_CHECKSUM"
    printf 'web_build_sha256=%s\n' "$WEB_BUILD_CHECKSUM"
    printf 'database_backup=%s\n' "$DB_BACKUP"
    printf 'uploads_backup=%s\n' "$UPLOADS_BACKUP"
    printf 'redis_rollback_volume=%s\n' "$REDIS_ROLLBACK_VOLUME"
    printf 'old_redis_volume=%s\n' "$OLD_REDIS_VOLUME"
    printf 'old_api_image_id=%s\n' "$OLD_API_IMAGE_ID"
    printf 'old_api_image_ref=%s\n' "$OLD_API_IMAGE_REF"
    printf 'old_web_image_id=%s\n' "$OLD_WEB_IMAGE_ID"
    printf 'old_web_image_ref=%s\n' "$OLD_WEB_IMAGE_REF"
    printf 'bullmq_snapshot=%s\n' "$REDIS_QUEUE_SNAPSHOT"
  } > "$RECOVERY_MANIFEST"
  chmod 600 "$RECOVERY_MANIFEST"
  echo "[deploy-prod] Recovery triplet and image provenance recorded: ${RECOVERY_MANIFEST}"

  # Prove that Redis 7 can load the complete copied persistence set before the
  # release crosses the migration boundary. Clone the target first: even a clean
  # Redis shutdown may rewrite persistence, so the verifier must never mount the
  # actual rollback/cutover volume read-write.
  REDIS_VERIFY_VOLUME_CANDIDATE="${PROJECT_NAME}-redis-verify-${DEPLOY_STAMP}-${GIT_SHA:0:12}"
  docker volume inspect "$REDIS_VERIFY_VOLUME_CANDIDATE" >/dev/null 2>&1 && {
    echo '[deploy-prod] ERROR: disposable Redis verification volume already exists' >&2
    exit 1
  }
  docker volume create \
    --label 'com.23telecom.helpdesk.temporary=true' \
    "$REDIS_VERIFY_VOLUME_CANDIDATE" >/dev/null
  REDIS_VERIFY_VOLUME="$REDIS_VERIFY_VOLUME_CANDIDATE"
  docker run --rm --user 0 \
    -v "$REDIS_DATA_VOLUME:/from:ro" \
    -v "$REDIS_VERIFY_VOLUME:/to" \
    "$REDIS_IMAGE" \
    sh -ec 'cp -a /from/. /to/ && chown -R redis:redis /to'

  # The disposable instance has no published port and both it and its cloned
  # volume are removed before Compose starts.
  REDIS_VERIFY_CONTAINER_CANDIDATE="telecom-hd-redis-restore-check-$$"
  docker container inspect "$REDIS_VERIFY_CONTAINER_CANDIDATE" >/dev/null 2>&1 && {
    echo '[deploy-prod] ERROR: disposable Redis verification container already exists' >&2
    exit 1
  }
  docker run -d \
    --name "$REDIS_VERIFY_CONTAINER_CANDIDATE" \
    -v "$REDIS_VERIFY_VOLUME:/data" \
    "$REDIS_IMAGE" \
    redis-server --requirepass "$REDIS_PASSWORD" --appendonly yes --appendfsync everysec \
      --aof-load-truncated no >/dev/null
  REDIS_VERIFY_CONTAINER="$REDIS_VERIFY_CONTAINER_CANDIDATE"
  REDIS_VERIFY_READY=false
  for _attempt in $(seq 1 90); do
    if docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_VERIFY_CONTAINER" \
      redis-cli --no-auth-warning PING >/dev/null 2>&1; then
      REDIS_VERIFY_READY=true
      break
    fi
    sleep 1
  done
  [[ "$REDIS_VERIFY_READY" == true ]] || {
    echo '[deploy-prod] ERROR: copied Redis persistence cannot be loaded' >&2
    docker logs --tail 50 "$REDIS_VERIFY_CONTAINER" >&2 || true
    exit 1
  }
  REDIS_KEYS_VERIFIED="$(
    docker exec -e REDISCLI_AUTH="$REDIS_PASSWORD" "$REDIS_VERIFY_CONTAINER" \
      redis-cli --no-auth-warning --raw DBSIZE
  )"
  if (( REDIS_KEYS_BEFORE > 0 && REDIS_KEYS_VERIFIED == 0 )); then
    echo '[deploy-prod] ERROR: Redis restore rehearsal loaded zero keys' >&2
    exit 1
  fi
  REDIS_QUEUE_VERIFIED="$(
    docker run --rm \
      --network "container:${REDIS_VERIFY_CONTAINER}" \
      -e "REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379" \
      "telecom-hd-api:${RELEASE_ID}" \
      node dist/seed/audit-redis-cutover.js --snapshot
  )"
  if [[ "$REDIS_QUEUE_VERIFIED" != "$REDIS_QUEUE_SNAPSHOT" ]]; then
    echo '[deploy-prod] ERROR: BullMQ state counts changed during Redis restore rehearsal' >&2
    exit 1
  fi
  docker stop -t 30 "$REDIS_VERIFY_CONTAINER" >/dev/null
  docker rm "$REDIS_VERIFY_CONTAINER" >/dev/null
  REDIS_VERIFY_CONTAINER=''
  docker volume rm "$REDIS_VERIFY_VOLUME" >/dev/null
  REDIS_VERIFY_VOLUME=''
  echo "[deploy-prod] Redis restore rehearsal keys=${REDIS_KEYS_VERIFIED}"
else
  echo '[deploy-prod] 5-8/12 first deployment: no live writers, backups or Redis state to migrate.'
fi

echo '[deploy-prod] 9/12 removing only inventoried legacy edges and starting internal services'
ROLL_FORWARD=true
for id in "$CADDY_ID" "$PROXY_ID"; do
  [[ -n "$id" ]] && docker rm "$id" >/dev/null
done
"${COMPOSE[@]}" up -d --no-build

echo '[deploy-prod] 10/12 waiting for internal API and web health checks'
API_READY=false
for attempt in $(seq 1 240); do
  if "${COMPOSE[@]}" exec -T api wget -qO- http://127.0.0.1:4000/api/health >/dev/null 2>&1; then
    API_READY=true
    break
  fi
  sleep 3
done
[[ "$API_READY" == true ]] || {
  echo '[deploy-prod] ERROR: API did not become healthy; edge remains off' >&2
  exit 1
}

WEB_READY=false
for attempt in $(seq 1 40); do
  if "${COMPOSE[@]}" exec -T web wget -qO- http://127.0.0.1:3000/login >/dev/null 2>&1; then
    WEB_READY=true
    break
  fi
  sleep 3
done
[[ "$WEB_READY" == true ]] || {
  echo '[deploy-prod] ERROR: web did not become healthy; edge remains off' >&2
  exit 1
}

echo '[deploy-prod] 11/12 running strict post-migration aggregate and scanner audits'
if [[ "$EXISTING_RELEASE" == false ]]; then
  echo '[deploy-prod] First deployment: creating the initial administrator via one-shot prompt'
  ENV_FILE="$ENV_FILE" scripts/bootstrap-admin.sh
fi
"${COMPOSE[@]}" exec -T api node dist/seed/audit-user-email-ownership.js
"${COMPOSE[@]}" exec -T api node dist/seed/audit-production-readiness.js
"${COMPOSE[@]}" exec -T api node dist/seed/audit-attachment-storage.js
"${COMPOSE[@]}" exec -T api node dist/seed/audit-scanner-readiness.js

if [[ "$EXISTING_RELEASE" == true && "$REDIS_KEYS_BEFORE" =~ ^[0-9]+$ ]]; then
  REDIS_PASSWORD="$(env_value TELECOM_HD_REDIS_PASSWORD)"
  REDIS_KEYS_AFTER="$(
    "${COMPOSE[@]}" exec -T -e REDISCLI_AUTH="$REDIS_PASSWORD" redis \
      redis-cli --no-auth-warning --raw DBSIZE
  )"
  if (( REDIS_KEYS_BEFORE > 0 && REDIS_KEYS_AFTER == 0 )); then
    echo '[deploy-prod] ERROR: Redis snapshot did not load; edge remains off' >&2
    exit 1
  fi
  echo "[deploy-prod] Redis aggregate keys before=${REDIS_KEYS_BEFORE} after=${REDIS_KEYS_AFTER}"
fi

if [[ "$QUEUES_PAUSED" == true ]]; then
  echo '[deploy-prod] All post-migration gates passed; resuming BullMQ workers'
  "${COMPOSE[@]}" exec -T api node dist/seed/audit-redis-cutover.js --resume
  QUEUES_PAUSED=false
fi

echo '[deploy-prod] 12/12 internal service summary'
"${COMPOSE[@]}" ps
QUIESCED=false
trap - EXIT HUP INT TERM
echo '[deploy-prod] Internal release is healthy and audited. No host ports or public edge were started.'
echo '[deploy-prod] Keep traffic closed until approved HTTPS edge, cookie smoke and external firewall checks pass.'
