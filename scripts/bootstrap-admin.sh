#!/usr/bin/env bash
# Create the first production administrator through a removed one-shot container.
# The credential is read from the terminal and never stored in .env.prod or the
# long-running API container configuration.
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
COMPOSE=(docker compose --profile scanner -f "${REPO_ROOT}/docker-compose.prod.yml" --env-file "$ENV_FILE")

[[ -f "$ENV_FILE" ]] || { echo 'ERROR: .env.prod not found' >&2; exit 1; }
export TELECOM_HD_WEB_BUILD_ID="${TELECOM_HD_WEB_BUILD_ID:-$("${SCRIPT_DIR}/web-build-id.sh" "$ENV_FILE")}"

[[ -t 0 ]] || {
  echo 'ERROR: first-admin bootstrap requires an interactive terminal' >&2
  echo 'Run scripts/bootstrap-admin.sh from the production management session.' >&2
  exit 1
}

IFS= read -r -p 'First administrator email: ' TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL
IFS= read -r -s -p 'Strong first administrator password: ' TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD
echo
IFS= read -r -s -p 'Confirm first administrator password: ' TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD_CONFIRM
echo

TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL="$(
  printf '%s' "$TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
)"
[[ "$TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || {
  echo 'ERROR: administrator email is invalid' >&2
  exit 1
}
[[ "$TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD" == "$TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD_CONFIRM" ]] || {
  echo 'ERROR: administrator passwords do not match' >&2
  exit 1
}
TRIMMED_PASSWORD="$(
  printf '%s' "$TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
)"
[[ ${#TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD} -ge 12 && ${#TRIMMED_PASSWORD} -ge 12 ]] || {
  echo 'ERROR: administrator password must be at least 12 characters' >&2
  exit 1
}
unset TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD_CONFIRM TRIMMED_PASSWORD

export TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD
"${COMPOSE[@]}" run --rm --no-deps -T \
  -e TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL \
  -e TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD \
  api node dist/seed/bootstrap-admin.js
unset TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD

echo '[bootstrap-admin] One-shot container removed; no bootstrap credential was added to .env.prod.'
