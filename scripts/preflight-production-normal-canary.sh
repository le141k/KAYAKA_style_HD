#!/usr/bin/env bash
# Validate the attended, promotion-only normal inbound canary without sourcing
# or printing the production environment file. This is not a deploy preflight:
# it is used only after a completed capture-only review, before promoting one
# immutable CAPTURED delivery into the normal ledger drain.
set -u -o pipefail

if (( $# > 1 )); then
  printf '%s\n' 'Usage: bash scripts/preflight-production-normal-canary.sh [path/to/.env.prod]' >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="${1:-"$ROOT_DIR/.env.prod"}"
if [[ "$ENV_FILE" != /* ]]; then ENV_FILE="$(pwd -P)/$ENV_FILE"; fi
PRODUCTION_ENV_FILE="$ROOT_DIR/.env.prod"
MAX_SAFE_ID='9007199254740991'
PASS=0
FAIL=0

ok() { printf '[production-normal-canary-preflight] OK %s\n' "$*"; PASS=$((PASS + 1)); }
fail() { printf '[production-normal-canary-preflight] FAIL %s\n' "$*" >&2; FAIL=$((FAIL + 1)); }

# Read literal dotenv values only. Never source secret data as shell code.
get_val() {
  local key="$1" line value
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -n 1 || true)"
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  if [[ ${#value} -ge 2 ]] && { [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]] || [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; }; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

assert_no_duplicate_keys() {
  local duplicates
  duplicates="$(sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\1/p' "$ENV_FILE" | sort | uniq -d || true)"
  if [[ -n "$duplicates" ]]; then
    while IFS= read -r key; do [[ -n "$key" ]] && fail "$key is defined more than once"; done <<< "$duplicates"
  else
    ok 'environment file has no duplicate keys'
  fi
}

is_true() { local v; v="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; [[ "$v" == true || "$v" == 1 || "$v" == yes ]]; }
is_false() { local v; v="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"; [[ "$v" == false || "$v" == 0 || "$v" == no ]]; }
is_safe_id() {
  local value="$1"
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || return 1
  (( ${#value} < ${#MAX_SAFE_ID} )) && return 0
  (( ${#value} > ${#MAX_SAFE_ID} )) && return 1
  [[ "$value" < "$MAX_SAFE_ID" || "$value" == "$MAX_SAFE_ID" ]]
}
require_true() { local key="$1"; if is_true "$(get_val "$key")"; then ok "$key is enabled"; else fail "$key must be true for the normal canary"; fi; }
require_false() { local key="$1"; if is_false "$(get_val "$key")"; then ok "$key is fail-closed"; else fail "$key must be false for the normal canary"; fi; }
require_blank() { local key="$1"; if [[ -z "$(get_val "$key")" ]]; then ok "$key is blank"; else fail "$key must be blank for the normal canary"; fi; }
require_safe_id() { local key="$1" value; value="$(get_val "$key")"; if is_safe_id "$value"; then ok "$key is a positive safe id"; else fail "$key must be one positive safe id"; fi; }

if [[ ! -f "$ENV_FILE" ]]; then
  fail 'environment file does not exist or is not a regular file'
elif [[ -L "$ENV_FILE" ]]; then
  fail 'environment file must not be a symlink'
else
  if [[ "$ENV_FILE" != "$PRODUCTION_ENV_FILE" && "${NODE_ENV:-}" != test ]]; then
    fail 'production normal-canary preflight may inspect only this checkout .env.prod'
  fi
  FILE_PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
  case "$FILE_PERMS" in
    600|400) ok 'environment file is exact owner-only' ;;
    *) fail 'environment file permissions must be exactly 0600 or 0400' ;;
  esac
  assert_no_duplicate_keys
  [[ "$(get_val 'NODE_ENV')" == production ]] && ok 'NODE_ENV is production' || fail 'NODE_ENV must be production'

  require_true 'TELECOM_HD_INBOUND_DELIVERY_ENABLED'
  require_false 'TELECOM_HD_INBOUND_CAPTURE_ONLY_ENABLED'
  require_false 'TELECOM_HD_IMAP_ENABLED'
  require_false 'TELECOM_HD_OUTBOUND_DELIVERY_ENABLED'
  require_blank 'TELECOM_HD_OUTBOUND_CANARY_EMAIL_ID'
  require_blank 'TELECOM_HD_OUTBOUND_CANARY_RECIPIENT'
  require_safe_id 'TELECOM_HD_INBOUND_NORMAL_CANARY_QUEUE_ID'
  require_safe_id 'TELECOM_HD_INBOUND_NORMAL_CANARY_DELIVERY_ID'

  if [[ "$(get_val 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY')" == FROM_NOW ]]; then
    ok 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY is FROM_NOW'
  else
    fail 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY must remain FROM_NOW for the attended canary'
  fi
  if [[ "$(get_val 'TELECOM_HD_IMAP_BACKFILL_LIMIT')" == 0 ]]; then
    ok 'TELECOM_HD_IMAP_BACKFILL_LIMIT is zero'
  else
    fail 'TELECOM_HD_IMAP_BACKFILL_LIMIT must remain 0 for the attended canary'
  fi
  if [[ "$(get_val 'TELECOM_HD_FIELD_ENCRYPTION_KEY')" =~ ^[0-9A-Fa-f]{64}$ ]]; then
    ok 'TELECOM_HD_FIELD_ENCRYPTION_KEY has a valid 256-bit format'
  else
    fail 'TELECOM_HD_FIELD_ENCRYPTION_KEY must be exactly 64 hex characters'
  fi
fi

printf '[production-normal-canary-preflight] %s passed, %s failed\n' "$PASS" "$FAIL"
(( FAIL == 0 ))
