#!/usr/bin/env bash
# Validate the attended, one-message production IMAP capture configuration without
# sourcing or printing the production environment file. This is intentionally separate
# from both deploy-prod's normal preflight (which correctly requires capture=false)
# and the local test preflight (which must reject production configuration).
set -u -o pipefail

if (( $# > 1 )); then
  printf '%s\n' 'Usage: bash scripts/preflight-production-capture-only.sh [path/to/.env.prod]' >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="${1:-"$ROOT_DIR/.env.prod"}"
if [[ "$ENV_FILE" != /* ]]; then
  ENV_FILE="$(pwd -P)/$ENV_FILE"
fi
PRODUCTION_ENV_FILE="$ROOT_DIR/.env.prod"
MAX_SAFE_QUEUE_ID='9007199254740991'
PASS=0
FAIL=0

ok() {
  printf '[production-capture-preflight] OK %s\n' "$*"
  PASS=$((PASS + 1))
}

fail() {
  printf '[production-capture-preflight] FAIL %s\n' "$*" >&2
  FAIL=$((FAIL + 1))
}

# Read literal dotenv values only. Never source an environment file: it is secret data,
# not executable shell code.
get_val() {
  local key="$1" line value
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -n 1 || true)"
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] ||
       [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s' "$value"
}

assert_no_duplicate_keys() {
  local duplicate_keys
  duplicate_keys="$(sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\1/p' "$ENV_FILE" | sort | uniq -d || true)"
  if [[ -n "$duplicate_keys" ]]; then
    while IFS= read -r key; do
      [[ -n "$key" ]] && fail "$key is defined more than once"
    done <<< "$duplicate_keys"
  else
    ok 'environment file has no duplicate keys'
  fi
}

is_true() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == true || "$value" == 1 || "$value" == yes ]]
}

is_false() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  [[ "$value" == false || "$value" == 0 || "$value" == no ]]
}

is_safe_queue_id() {
  local value="$1"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
  (( ${#value} < ${#MAX_SAFE_QUEUE_ID} )) && return 0
  (( ${#value} > ${#MAX_SAFE_QUEUE_ID} )) && return 1
  [[ "$value" < "$MAX_SAFE_QUEUE_ID" || "$value" == "$MAX_SAFE_QUEUE_ID" ]]
}

require_false() {
  local key="$1" value
  value="$(get_val "$key")"
  if is_false "$value"; then
    ok "$key is fail-closed"
  else
    fail "$key must be false for production capture-only"
  fi
}

require_blank() {
  local key="$1" value
  value="$(get_val "$key")"
  if [[ -z "$value" ]]; then
    ok "$key is blank"
  else
    fail "$key must be blank for production capture-only"
  fi
}

if [[ ! -f "$ENV_FILE" ]]; then
  fail 'environment file does not exist or is not a regular file'
elif [[ -L "$ENV_FILE" ]]; then
  fail 'environment file must not be a symlink'
else
  # Unit tests use an isolated temp path under NODE_ENV=test. Interactive use is
  # intentionally restricted to this clean checkout's production env file.
  if [[ "$ENV_FILE" != "$PRODUCTION_ENV_FILE" && "${NODE_ENV:-}" != test ]]; then
    fail 'production capture preflight may inspect only this checkout .env.prod'
  fi

  FILE_PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
  case "$FILE_PERMS" in
    600|400) ok 'environment file is exact owner-only' ;;
    *) fail 'environment file permissions must be exactly 0600 or 0400' ;;
  esac

  assert_no_duplicate_keys
  if [[ "$(get_val 'NODE_ENV')" == production ]]; then
    ok 'NODE_ENV is production'
  else
    fail 'NODE_ENV must be production'
  fi
  require_false 'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED'
  require_false 'TELECOM_HD_INBOUND_DELIVERY_ENABLED'
  require_blank 'TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID'
  require_blank 'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT'
  require_blank 'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID'
  require_blank 'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID'

  if is_true "$(get_val 'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED')"; then
    ok 'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED is enabled'
  else
    fail 'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED must be true for the attended capture'
  fi

  QUEUE_ID="$(get_val 'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID')"
  if is_safe_queue_id "$QUEUE_ID"; then
    ok 'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID is a positive safe queue id'
  else
    fail 'TELECOM_HD_INBOUND_CAPTURE_QUEUE_ID must be one positive safe selected queue id'
  fi

  if [[ "$(get_val 'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES')" == 1 ]]; then
    ok 'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES is exactly one'
  else
    fail 'TELECOM_HD_INBOUND_CAPTURE_MAX_MESSAGES must be exactly 1 for this canary'
  fi

  FIELD_KEY="$(get_val 'TELECOM_HD_FIELD_ENCRYPTION_KEY')"
  if [[ "$FIELD_KEY" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    ok 'TELECOM_HD_FIELD_ENCRYPTION_KEY has a valid 256-bit format'
  else
    fail 'TELECOM_HD_FIELD_ENCRYPTION_KEY must be exactly 64 hex characters'
  fi

  if is_true "$(get_val 'TELECOM_HD_IMAP_ENABLED')"; then
    ok 'TELECOM_HD_IMAP_ENABLED is enabled for the selected queue'
  else
    fail 'TELECOM_HD_IMAP_ENABLED must be true for the attended capture'
  fi
  if [[ "$(get_val 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY')" == FROM_NOW ]]; then
    ok 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY is FROM_NOW'
  else
    fail 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY must be FROM_NOW for a no-history canary'
  fi
  if [[ "$(get_val 'TELECOM_HD_IMAP_BACKFILL_LIMIT')" == 0 ]]; then
    ok 'TELECOM_HD_IMAP_BACKFILL_LIMIT is zero'
  else
    fail 'TELECOM_HD_IMAP_BACKFILL_LIMIT must be 0 for a no-history canary'
  fi
fi

if (( FAIL > 0 )); then
  printf '%s\n' '[production-capture-preflight] Capture restart is blocked; no application state was changed.' >&2
  exit 1
fi

printf '%s\n' '[production-capture-preflight] Attended one-message production capture configuration is ready.'
