#!/usr/bin/env bash
# Validate production configuration before Docker Compose can read or expose it.
# Usage: ./scripts/preflight.sh [path/to/env/file]
# This script reports key names and rules only; it never prints secret values.
set -euo pipefail

ENV_FILE="${1:-.env.prod}"
PASS=0
FAIL=0

ok() {
  printf '  [✓] %s\n' "$*"
  PASS=$((PASS + 1))
}

fail() {
  printf '  [✗] %s\n' "$*" >&2
  FAIL=$((FAIL + 1))
}

get_val() {
  local key="$1" line value
  line="$(grep -E "^${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null | head -1 || true)"
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

require_nonempty() {
  local key="$1"
  if [[ -n "$(get_val "$key")" ]]; then
    ok "$key — present"
  else
    fail "$key — missing or empty"
  fi
}

is_true() {
  local value
  value="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    true|1|yes) return 0 ;;
    *) return 1 ;;
  esac
}

check_bool() {
  local key="$1" value
  value="$(get_val "$key")"
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    true|false|1|0|yes|no) ok "$key — valid boolean" ;;
    *) fail "$key — must be true or false" ;;
  esac
}

check_int() {
  local key="$1" min="$2" max="$3" value number
  value="$(get_val "$key")"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    fail "$key — must be an integer"
    return
  fi
  number=$((10#$value))
  if (( number < min || number > max )); then
    fail "$key — must be between $min and $max"
  else
    ok "$key — valid range"
  fi
}

PLACEHOLDER_RE='(change[-_]?me|dev[-_]?secret|placeholder|example|changeme|0{4,}|demo1234)'

check_not_placeholder() {
  local key="$1" value="$2"
  if printf '%s' "$value" | grep -qiE "$PLACEHOLDER_RE"; then
    fail "$key — matches a placeholder/default pattern"
  else
    ok "$key — not a placeholder/default"
  fi
}

check_secret() {
  local key="$1" min_length="$2" value
  value="$(get_val "$key")"
  if [[ -z "$value" ]]; then
    return
  fi
  if (( ${#value} < min_length )); then
    fail "$key — too short (minimum $min_length characters)"
  else
    ok "$key — minimum length satisfied"
  fi
  check_not_placeholder "$key" "$value"
}

origin_host() {
  local url="$1" remainder
  remainder="${url#https://}"
  printf '%s' "$remainder"
}

printf '\n=== production preflight: %s ===\n\n' "$ENV_FILE"

printf '%s\n' '--- 0. File and syntax ---'
if [[ ! -f "$ENV_FILE" ]]; then
  fail "$ENV_FILE — file not found"
  exit 1
fi
ok "$ENV_FILE — exists"

FILE_PERMS="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE" 2>/dev/null || true)"
case "$FILE_PERMS" in
  600|400) ok "$ENV_FILE — exact owner-only permissions ($FILE_PERMS)" ;;
  *) fail "$ENV_FILE — permissions must be exactly 0600 or 0400; run: chmod 600 $ENV_FILE" ;;
esac

if grep -qE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*<<<' "$ENV_FILE" 2>/dev/null; then
  fail "$ENV_FILE — contains an unfilled <<< placeholder"
else
  ok "$ENV_FILE — no <<< placeholders"
fi

DUPLICATE_KEYS="$(sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\1/p' "$ENV_FILE" | sort | uniq -d || true)"
if [[ -n "$DUPLICATE_KEYS" ]]; then
  while IFS= read -r key; do fail "$key — duplicate definition"; done <<< "$DUPLICATE_KEYS"
else
  ok "$ENV_FILE — no duplicate keys"
fi

printf '\n%s\n' '--- 1. Required production keys ---'
REQUIRED_KEYS=(
  NODE_ENV TELECOM_HD_RELEASE DOMAIN TELECOM_HD_PUBLIC_URL
  TELECOM_HD_DB_USER TELECOM_HD_DB_PASSWORD TELECOM_HD_DB_NAME TELECOM_HD_REDIS_PASSWORD
  TELECOM_HD_JWT_ACCESS_SECRET TELECOM_HD_JWT_REFRESH_SECRET
  TELECOM_HD_ALARIS_WEBHOOK_SECRET TELECOM_HD_INBOUND_WEBHOOK_SECRET
  TELECOM_HD_FIELD_ENCRYPTION_KEY
  TELECOM_HD_SMTP_HOST TELECOM_HD_SMTP_PORT TELECOM_HD_SMTP_SECURE
  TELECOM_HD_SMTP_USER TELECOM_HD_SMTP_PASSWORD TELECOM_HD_MAIL_FROM
  TELECOM_HD_UPLOAD_DIR
  TELECOM_HD_CLIENT_PORTAL_ENABLED TELECOM_HD_CLIENT_UPLOAD_ENABLED
  TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED TELECOM_HD_PUBLIC_UPLOAD_ENABLED
  TELECOM_HD_UPLOAD_MAX_SIZE_MB TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB
  TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB TELECOM_HD_INBOUND_MAX_SIZE_MB
  TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT
  TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB
  TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS
  TELECOM_HD_IMAP_ENABLED TELECOM_HD_IMAP_BOOTSTRAP_POLICY TELECOM_HD_IMAP_BACKFILL_LIMIT
  TELECOM_HD_INBOUND_MAX_ATTEMPTS TELECOM_HD_INBOUND_RAW_RETENTION_DAYS
  TELECOM_HD_CLAMAV_ENABLED TELECOM_HD_CLAMAV_HOST
  TELECOM_HD_CLAMAV_PORT TELECOM_HD_CLAMAV_TIMEOUT_MS COMPOSE_PROFILES
)
for key in "${REQUIRED_KEYS[@]}"; do require_nonempty "$key"; done

printf '\n%s\n' '--- 2. Origins and mail delivery ---'
NODE_ENV_VALUE="$(get_val NODE_ENV)"
[[ "$NODE_ENV_VALUE" == production ]] && ok 'NODE_ENV — production' || fail 'NODE_ENV — must be production'

RELEASE_ID="$(get_val TELECOM_HD_RELEASE)"
if [[ "$RELEASE_ID" =~ ^[0-9a-fA-F]{7,40}$ ]]; then
  ok 'TELECOM_HD_RELEASE — immutable git identifier'
else
  fail 'TELECOM_HD_RELEASE — must be a 7-40 character hexadecimal git identifier'
fi

PUBLIC_URL="$(get_val TELECOM_HD_PUBLIC_URL)"
PUBLIC_HOST=''
if [[ "$PUBLIC_URL" == https://* ]] &&
   [[ "${PUBLIC_URL#https://}" != *'/'* ]] &&
   [[ "${PUBLIC_URL#https://}" != *'?'* ]] &&
   [[ "${PUBLIC_URL#https://}" != *'#'* ]] &&
   [[ "${PUBLIC_URL#https://}" != *'@'* ]] &&
   [[ "${PUBLIC_URL#https://}" != *':'* ]]; then
  PUBLIC_HOST="$(origin_host "$PUBLIC_URL")"
  if [[ "$PUBLIC_HOST" =~ ^(localhost|127\.0\.0\.1|\[::1\])$ ]] ||
     [[ "$PUBLIC_HOST" =~ (^|\.)example\.(com|net|org)$ ]] ||
     [[ "$PUBLIC_HOST" =~ \.example$ ]]; then
    fail 'TELECOM_HD_PUBLIC_URL — must use the real production hostname'
  else
    ok 'TELECOM_HD_PUBLIC_URL — canonical HTTPS origin'
  fi
else
  fail 'TELECOM_HD_PUBLIC_URL — must be https://host with no path, credentials, port, query or fragment'
fi

DOMAIN="$(get_val DOMAIN)"
if [[ ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  fail 'DOMAIN — must be a valid fully-qualified DNS hostname'
elif [[ -n "$PUBLIC_HOST" && "$DOMAIN" == "$PUBLIC_HOST" ]]; then
  ok 'DOMAIN — matches TELECOM_HD_PUBLIC_URL hostname'
else
  fail 'DOMAIN — must exactly match TELECOM_HD_PUBLIC_URL hostname'
fi

NEXT_API_URL="$(get_val NEXT_PUBLIC_API_URL)"
if [[ -z "$NEXT_API_URL" ]]; then
  ok 'NEXT_PUBLIC_API_URL — empty (same-origin /api)'
elif [[ "$NEXT_API_URL" == "$PUBLIC_URL" ]]; then
  ok 'NEXT_PUBLIC_API_URL — matches the public HTTPS origin'
else
  fail 'NEXT_PUBLIC_API_URL — must be empty or exactly match TELECOM_HD_PUBLIC_URL'
fi

SMTP_HOST="$(get_val TELECOM_HD_SMTP_HOST)"
if [[ -z "$SMTP_HOST" ]] ||
   [[ "$SMTP_HOST" =~ ^(localhost|127\.0\.0\.1|\[::1\]|mailhog)$ ]] ||
   [[ "$SMTP_HOST" =~ (^|\.)example\.(com|net|org)$ ]] ||
   [[ "$SMTP_HOST" =~ \.example$ ]]; then
  fail 'TELECOM_HD_SMTP_HOST — must be a real non-local relay hostname'
else
  ok 'TELECOM_HD_SMTP_HOST — non-local relay'
fi
check_int TELECOM_HD_SMTP_PORT 1 65535
check_bool TELECOM_HD_SMTP_SECURE
SMTP_PORT="$(get_val TELECOM_HD_SMTP_PORT)"
SMTP_SECURE="$(get_val TELECOM_HD_SMTP_SECURE)"
if [[ "$SMTP_PORT" == 465 ]] && ! is_true "$SMTP_SECURE"; then
  fail 'TELECOM_HD_SMTP_SECURE — port 465 requires true'
elif [[ "$SMTP_PORT" == 587 ]] && is_true "$SMTP_SECURE"; then
  fail 'TELECOM_HD_SMTP_SECURE — port 587 uses STARTTLS and must be false'
else
  ok 'TELECOM_HD_SMTP_SECURE — consistent with SMTP port'
fi

MAIL_FROM="$(get_val TELECOM_HD_MAIL_FROM)"
if [[ "$MAIL_FROM" == *'@'* ]] &&
   ! printf '%s' "$MAIL_FROM" | grep -qiE '(localhost|@.*\.example([>[:space:]]|$)|@example\.(com|net|org))'; then
  ok 'TELECOM_HD_MAIL_FROM — non-placeholder sender'
else
  fail 'TELECOM_HD_MAIL_FROM — must contain a real sender address'
fi

printf '\n%s\n' '--- 3. Secrets and bootstrap identity ---'
for key in TELECOM_HD_DB_USER TELECOM_HD_DB_NAME; do
  value="$(get_val "$key")"
  if [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]]; then
    ok "$key — safe for PostgreSQL and the generated connection URL"
  else
    fail "$key — use letters, digits, underscore or hyphen and start with a letter/underscore"
  fi
done

check_secret TELECOM_HD_DB_PASSWORD 16
check_secret TELECOM_HD_REDIS_PASSWORD 16
check_secret TELECOM_HD_JWT_ACCESS_SECRET 32
check_secret TELECOM_HD_JWT_REFRESH_SECRET 32
check_secret TELECOM_HD_ALARIS_WEBHOOK_SECRET 32
check_secret TELECOM_HD_INBOUND_WEBHOOK_SECRET 32
check_secret TELECOM_HD_SMTP_PASSWORD 12

for key in TELECOM_HD_DB_PASSWORD TELECOM_HD_REDIS_PASSWORD; do
  value="$(get_val "$key")"
  if [[ -n "$value" && "$value" =~ ^[A-Za-z0-9_-]+$ ]]; then
    ok "$key — URL-safe for the generated connection URL"
  elif [[ -n "$value" ]]; then
    fail "$key — use URL-safe characters (A-Z, a-z, 0-9, underscore, hyphen)"
  fi
done

JWT_ACCESS="$(get_val TELECOM_HD_JWT_ACCESS_SECRET)"
JWT_REFRESH="$(get_val TELECOM_HD_JWT_REFRESH_SECRET)"
if [[ -n "$JWT_ACCESS" && "$JWT_ACCESS" != "$JWT_REFRESH" ]]; then
  ok 'JWT access and refresh secrets — distinct'
else
  fail 'JWT access and refresh secrets — must be distinct'
fi

FIELD_KEY="$(get_val TELECOM_HD_FIELD_ENCRYPTION_KEY)"
if [[ "$FIELD_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  ok 'TELECOM_HD_FIELD_ENCRYPTION_KEY — exactly 64 hex characters'
  check_not_placeholder TELECOM_HD_FIELD_ENCRYPTION_KEY "$FIELD_KEY"
else
  fail 'TELECOM_HD_FIELD_ENCRYPTION_KEY — must be exactly 64 hex characters'
fi

for key in TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD; do
  if [[ -z "$(get_val "$key")" ]]; then
    ok "$key — absent from the long-running runtime environment"
  else
    fail "$key — remove from .env.prod; bootstrap uses scripts/bootstrap-admin.sh once"
  fi
done

SEED_VALUE="$(get_val TELECOM_HD_SEED)"
if [[ -z "$SEED_VALUE" ]] || ! is_true "$SEED_VALUE"; then
  ok 'TELECOM_HD_SEED — disabled/unset'
else
  fail 'TELECOM_HD_SEED — must be disabled/unset in production'
fi

printf '\n%s\n' '--- 4. Public-surface kill switches and size limits ---'
for key in TELECOM_HD_CLIENT_PORTAL_ENABLED TELECOM_HD_CLIENT_UPLOAD_ENABLED \
  TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED TELECOM_HD_PUBLIC_UPLOAD_ENABLED \
  TELECOM_HD_CLAMAV_ENABLED; do
  check_bool "$key"
done

check_int TELECOM_HD_UPLOAD_MAX_SIZE_MB 1 25
check_int TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB 1 50
check_int TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB 1 55
check_int TELECOM_HD_INBOUND_MAX_SIZE_MB 1 35
check_int TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS 1 168
check_int TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT 100 5000
check_int TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB 100 10240
check_int TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB 256 10240
check_int TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS 1 5000
check_int TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS 10 300

UPLOAD_DIR="$(get_val TELECOM_HD_UPLOAD_DIR)"
if [[ "$UPLOAD_DIR" == /app/uploads ]]; then
  ok 'TELECOM_HD_UPLOAD_DIR — exactly the durable Compose mount /app/uploads'
else
  fail 'TELECOM_HD_UPLOAD_DIR — must be exactly /app/uploads in production'
fi

PER_FILE="$(get_val TELECOM_HD_UPLOAD_MAX_SIZE_MB)"
TOTAL_UPLOAD="$(get_val TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB)"
REQUEST_UPLOAD="$(get_val TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB)"
INBOUND_MAX="$(get_val TELECOM_HD_INBOUND_MAX_SIZE_MB)"
if [[ "$PER_FILE" =~ ^[0-9]+$ && "$TOTAL_UPLOAD" =~ ^[0-9]+$ ]] &&
   (( 10#$TOTAL_UPLOAD >= 10#$PER_FILE )); then
  ok 'TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB — at least the per-file limit'
else
  fail 'TELECOM_HD_UPLOAD_TOTAL_MAX_SIZE_MB — must be at least the per-file limit'
fi
if [[ "$TOTAL_UPLOAD" =~ ^[0-9]+$ && "$REQUEST_UPLOAD" =~ ^[0-9]+$ ]] &&
   (( 10#$REQUEST_UPLOAD >= 10#$TOTAL_UPLOAD )); then
  ok 'TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB — at least the aggregate file-byte limit'
else
  fail 'TELECOM_HD_UPLOAD_REQUEST_MAX_SIZE_MB — must be at least the aggregate file-byte limit'
fi
if [[ "$PER_FILE" =~ ^[0-9]+$ && "$INBOUND_MAX" =~ ^[0-9]+$ ]] &&
   (( 10#$INBOUND_MAX >= 10#$PER_FILE )); then
  ok 'TELECOM_HD_INBOUND_MAX_SIZE_MB — at least the per-file limit'
else
  fail 'TELECOM_HD_INBOUND_MAX_SIZE_MB — must be at least the per-file limit'
fi

PUBLIC_CREATE="$(get_val TELECOM_HD_PUBLIC_TICKET_CREATE_ENABLED)"
PUBLIC_UPLOAD="$(get_val TELECOM_HD_PUBLIC_UPLOAD_ENABLED)"
CLIENT_PORTAL="$(get_val TELECOM_HD_CLIENT_PORTAL_ENABLED)"
CLIENT_UPLOAD="$(get_val TELECOM_HD_CLIENT_UPLOAD_ENABLED)"
PUBLIC_CHALLENGE=false
if is_true "$CLIENT_PORTAL" || is_true "$CLIENT_UPLOAD" || is_true "$PUBLIC_CREATE" || is_true "$PUBLIC_UPLOAD"; then
  PUBLIC_CHALLENGE=true
fi

if is_true "$CLIENT_UPLOAD" && ! is_true "$CLIENT_PORTAL"; then
  fail 'Verified-client upload — cannot be enabled while the client portal is disabled'
else
  ok 'Verified-client upload — consistent with the client-portal switch'
fi

if is_true "$PUBLIC_UPLOAD" && ! is_true "$PUBLIC_CREATE"; then
  fail 'Public upload — cannot be enabled while public ticket creation is disabled'
else
  ok 'Public upload — consistent with public ticket creation switch'
fi

if [[ "$PUBLIC_CHALLENGE" == true ]]; then
  TURNSTILE_SECRET="$(get_val TELECOM_HD_TURNSTILE_SECRET)"
  TURNSTILE_HOST="$(get_val TELECOM_HD_TURNSTILE_HOSTNAME)"
  TURNSTILE_SITE_KEY="$(get_val NEXT_PUBLIC_TURNSTILE_SITE_KEY)"
  [[ -n "$TURNSTILE_SECRET" ]] && ok 'TELECOM_HD_TURNSTILE_SECRET — present' || fail 'TELECOM_HD_TURNSTILE_SECRET — required for the client/public challenge surface'
  [[ -n "$TURNSTILE_SITE_KEY" ]] && ok 'NEXT_PUBLIC_TURNSTILE_SITE_KEY — present' || fail 'NEXT_PUBLIC_TURNSTILE_SITE_KEY — required for the client/public challenge surface'
  [[ "$TURNSTILE_HOST" == "$PUBLIC_HOST" ]] && ok 'TELECOM_HD_TURNSTILE_HOSTNAME — matches public hostname' || fail 'TELECOM_HD_TURNSTILE_HOSTNAME — must match public hostname'
  [[ -n "$TURNSTILE_SECRET" ]] && check_secret TELECOM_HD_TURNSTILE_SECRET 20
  [[ -n "$TURNSTILE_SITE_KEY" ]] && check_not_placeholder NEXT_PUBLIC_TURNSTILE_SITE_KEY "$TURNSTILE_SITE_KEY"
else
  ok 'Client/public challenge surface — all switches are fail-closed'
fi

printf '\n%s\n' '--- 5. Inbound-mail global safety gates ---'
check_bool TELECOM_HD_IMAP_ENABLED

IMAP_BOOTSTRAP_POLICY="$(get_val TELECOM_HD_IMAP_BOOTSTRAP_POLICY)"
case "$IMAP_BOOTSTRAP_POLICY" in
  FROM_NOW|BACKFILL) ok 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY — explicit safe mode' ;;
  *) fail 'TELECOM_HD_IMAP_BOOTSTRAP_POLICY — must be FROM_NOW or BACKFILL' ;;
esac

check_int TELECOM_HD_IMAP_BACKFILL_LIMIT 0 10000
check_int TELECOM_HD_INBOUND_MAX_ATTEMPTS 1 20
check_int TELECOM_HD_INBOUND_RAW_RETENTION_DAYS 0 3650

IMAP_BACKFILL_LIMIT="$(get_val TELECOM_HD_IMAP_BACKFILL_LIMIT)"
if [[ "$IMAP_BOOTSTRAP_POLICY" == BACKFILL ]]; then
  if [[ "$IMAP_BACKFILL_LIMIT" =~ ^[0-9]+$ ]] && (( 10#$IMAP_BACKFILL_LIMIT >= 1 )); then
    ok 'IMAP BACKFILL — bounded, non-zero historical import is explicit'
  else
    fail 'IMAP BACKFILL — TELECOM_HD_IMAP_BACKFILL_LIMIT must be at least 1'
  fi
elif [[ "$IMAP_BOOTSTRAP_POLICY" == FROM_NOW && "$IMAP_BACKFILL_LIMIT" =~ ^[0-9]+$ ]]; then
  ok 'IMAP FROM_NOW — global historical import is disabled'
fi

printf '\n%s\n' '--- 6. Private malware scanner profile ---'
CLAMAV_ENABLED="$(get_val TELECOM_HD_CLAMAV_ENABLED)"
CLAMAV_HOST="$(get_val TELECOM_HD_CLAMAV_HOST)"
COMPOSE_PROFILES_VALUE="$(get_val COMPOSE_PROFILES)"
SCANNER_PROFILE=false
if printf ',%s,' "$COMPOSE_PROFILES_VALUE" | grep -qE ',[[:space:]]*scanner[[:space:]]*,'; then
  SCANNER_PROFILE=true
fi

if is_true "$CLAMAV_ENABLED"; then
  ok 'TELECOM_HD_CLAMAV_ENABLED — mandatory production scanner enabled'
  [[ "$CLAMAV_HOST" == clamav ]] && ok 'TELECOM_HD_CLAMAV_HOST — private Compose service' || fail 'TELECOM_HD_CLAMAV_HOST — must be clamav'
  [[ "$SCANNER_PROFILE" == true ]] && ok 'COMPOSE_PROFILES — scanner enabled' || fail 'COMPOSE_PROFILES — must include scanner'
else
  fail 'TELECOM_HD_CLAMAV_ENABLED — must be true for every production attachment source'
fi

[[ "$SCANNER_PROFILE" == true ]] || fail 'COMPOSE_PROFILES — scanner profile is mandatory in production'
ok 'Attachment plane — configured to fail closed through the private scanner'
check_int TELECOM_HD_CLAMAV_PORT 1 65535
check_int TELECOM_HD_CLAMAV_TIMEOUT_MS 1000 120000

printf '\n==============================\n'
printf 'Results: %d failure(s) / %d checks\n' "$FAIL" "$((PASS + FAIL))"
printf '%s\n' '=============================='
if (( FAIL > 0 )); then
  printf '%s\n' 'RESULT: FAIL — fix every issue before deployment.' >&2
  exit 1
fi
printf '%s\n' 'RESULT: PASS — configuration is ready for the production launch gate.'
