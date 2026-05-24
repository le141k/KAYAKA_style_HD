#!/usr/bin/env bash
# scripts/preflight.sh — pre-deploy env validation
# Usage: ./scripts/preflight.sh [path/to/env/file]
# Default env file: .env.prod
# Exits non-zero if any check fails. Never prints secret values.
set -euo pipefail

ENV_FILE="${1:-.env.prod}"

PASS=0
FAIL=0

ok()   { echo "  [✓] $*"; PASS=$(( PASS + 1 )); }
fail() { echo "  [✗] $*"; FAIL=$(( FAIL + 1 )); }

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

# Read a key from the env file. Returns empty string if absent.
# Never echoes the value to stdout in a way that the caller would log.
get_val() {
  local key="$1"
  # Match KEY=value; strip inline comments; trim leading/trailing whitespace.
  grep -E "^${key}[[:space:]]*=" "$ENV_FILE" 2>/dev/null \
    | head -1 \
    | sed "s/^${key}[[:space:]]*=[[:space:]]*//" \
    | sed 's/[[:space:]]*#.*//' \
    | sed "s/^['\"]//; s/['\"]$//"
}

# Check a key is present and non-empty.
require_nonempty() {
  local key="$1"
  local val
  val="$(get_val "$key")"
  if [[ -z "$val" ]]; then
    fail "$key — missing or empty"
    return 1
  fi
  ok "$key — present"
  return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# 0. File existence
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "=== preflight: $ENV_FILE ==="
echo

echo "--- 0. File check ---"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "  [✗] $ENV_FILE not found — aborting"
  exit 1
fi
ok "$ENV_FILE exists"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Unfilled placeholder marker check  (mirrors  <<<  convention)
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "--- 1. Unfilled placeholder markers ---"
# Only scan KEY=VALUE lines, not comments (the file header legitimately mentions '<<<').
placeholder_hits="$(grep -nE '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*<<<' "$ENV_FILE" 2>/dev/null || true)"
if [[ -n "$placeholder_hits" ]]; then
  while IFS= read -r line_with_num; do
    line_num="${line_with_num%%:*}"
    line_content="${line_with_num#*:}"
    key_name="$(echo "$line_content" | sed 's/=.*//')"
    fail "line ${line_num}: ${key_name} still contains '<<<' placeholder"
  done <<< "$placeholder_hits"
else
  ok "No '<<<' placeholder markers in any variable"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Required keys: present and non-empty
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "--- 2. Required keys ---"

REQUIRED_KEYS=(
  TELECOM_HD_PUBLIC_URL
  NEXT_PUBLIC_API_URL
  TELECOM_HD_DB_PASSWORD
  TELECOM_HD_REDIS_PASSWORD
  TELECOM_HD_JWT_ACCESS_SECRET
  TELECOM_HD_JWT_REFRESH_SECRET
  TELECOM_HD_ALARIS_WEBHOOK_SECRET
  TELECOM_HD_FIELD_ENCRYPTION_KEY
  TELECOM_HD_SMTP_HOST
  TELECOM_HD_SMTP_USER
  TELECOM_HD_SMTP_PASSWORD
  TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL
  TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD
)

for key in "${REQUIRED_KEYS[@]}"; do
  require_nonempty "$key" || true
done

# ─────────────────────────────────────────────────────────────────────────────
# 3. Semantic / security validations
#    Mirrors assertProductionSecrets() in apps/api/src/config/configuration.ts
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "--- 3. Semantic checks ---"

# 3a. PUBLIC_URL must start with https://
PUBLIC_URL="$(get_val TELECOM_HD_PUBLIC_URL)"
if [[ -n "$PUBLIC_URL" ]]; then
  if [[ "$PUBLIC_URL" == https://* ]]; then
    ok "TELECOM_HD_PUBLIC_URL — starts with https://"
  else
    fail "TELECOM_HD_PUBLIC_URL — must start with https:// (got scheme: ${PUBLIC_URL%%:*})"
  fi
fi

NEXT_API_URL="$(get_val NEXT_PUBLIC_API_URL)"
if [[ -n "$NEXT_API_URL" ]]; then
  if [[ "$NEXT_API_URL" == https://* ]]; then
    ok "NEXT_PUBLIC_API_URL — starts with https://"
  else
    fail "NEXT_PUBLIC_API_URL — must start with https:// (got scheme: ${NEXT_API_URL%%:*})"
  fi
fi

# 3b. JWT secrets >= 32 chars
JWT_ACCESS="$(get_val TELECOM_HD_JWT_ACCESS_SECRET)"
JWT_REFRESH="$(get_val TELECOM_HD_JWT_REFRESH_SECRET)"

if [[ -n "$JWT_ACCESS" ]]; then
  if (( ${#JWT_ACCESS} >= 32 )); then
    ok "TELECOM_HD_JWT_ACCESS_SECRET — length >= 32"
  else
    fail "TELECOM_HD_JWT_ACCESS_SECRET — too short (must be >= 32 chars)"
  fi
fi

if [[ -n "$JWT_REFRESH" ]]; then
  if (( ${#JWT_REFRESH} >= 32 )); then
    ok "TELECOM_HD_JWT_REFRESH_SECRET — length >= 32"
  else
    fail "TELECOM_HD_JWT_REFRESH_SECRET — too short (must be >= 32 chars)"
  fi
fi

# 3c. JWT access != refresh  (configuration.ts line 69)
if [[ -n "$JWT_ACCESS" && -n "$JWT_REFRESH" ]]; then
  if [[ "$JWT_ACCESS" != "$JWT_REFRESH" ]]; then
    ok "TELECOM_HD_JWT_ACCESS_SECRET != TELECOM_HD_JWT_REFRESH_SECRET"
  else
    fail "TELECOM_HD_JWT_ACCESS_SECRET and TELECOM_HD_JWT_REFRESH_SECRET must differ"
  fi
fi

# 3d. JWT secrets must not match PLACEHOLDER_PATTERN
#     pattern from configuration.ts: /change[-_]?me|dev[-_]?secret|placeholder|example|changeme|0{4,}/i
PLACEHOLDER_RE='(change[-_]?me|dev[-_]?secret|placeholder|example|changeme|0{4,})'

check_not_placeholder() {
  local key="$1"
  local val="$2"
  if echo "$val" | grep -qiE "$PLACEHOLDER_RE"; then
    fail "$key — matches placeholder/dev pattern (change-me, example, dev-secret, …)"
  else
    ok "$key — does not match placeholder pattern"
  fi
}

[[ -n "$JWT_ACCESS"  ]] && check_not_placeholder "TELECOM_HD_JWT_ACCESS_SECRET"  "$JWT_ACCESS"
[[ -n "$JWT_REFRESH" ]] && check_not_placeholder "TELECOM_HD_JWT_REFRESH_SECRET" "$JWT_REFRESH"

# 3e. ALARIS webhook secret >= 32 chars, not the shipped dev default, not placeholder
ALARIS_DEV_DEFAULT='alaris-dev-secret-change-me-0000'
ALARIS="$(get_val TELECOM_HD_ALARIS_WEBHOOK_SECRET)"
if [[ -n "$ALARIS" ]]; then
  if (( ${#ALARIS} >= 32 )); then
    ok "TELECOM_HD_ALARIS_WEBHOOK_SECRET — length >= 32"
  else
    fail "TELECOM_HD_ALARIS_WEBHOOK_SECRET — too short (must be >= 32 chars)"
  fi

  if [[ "$ALARIS" != "$ALARIS_DEV_DEFAULT" ]]; then
    ok "TELECOM_HD_ALARIS_WEBHOOK_SECRET — not the shipped dev default"
  else
    fail "TELECOM_HD_ALARIS_WEBHOOK_SECRET — must not be the shipped dev default"
  fi

  check_not_placeholder "TELECOM_HD_ALARIS_WEBHOOK_SECRET" "$ALARIS"
fi

# 3f. FIELD_ENCRYPTION_KEY must be exactly 64 hex chars  (configuration.ts line 73)
FENC="$(get_val TELECOM_HD_FIELD_ENCRYPTION_KEY)"
if [[ -n "$FENC" ]]; then
  if echo "$FENC" | grep -qE '^[0-9a-fA-F]{64}$'; then
    ok "TELECOM_HD_FIELD_ENCRYPTION_KEY — exactly 64 hex chars"
  else
    fail "TELECOM_HD_FIELD_ENCRYPTION_KEY — must be exactly 64 hex chars (256-bit); got length ${#FENC}"
  fi
fi

# 3g. Bootstrap admin password must not be the demo default
ADMIN_PASS="$(get_val TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD)"
if [[ -n "$ADMIN_PASS" ]]; then
  if [[ "$ADMIN_PASS" == "demo1234" ]]; then
    fail "TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD — must not be the demo default (demo1234)"
  else
    ok "TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD — not the demo default"
  fi
  check_not_placeholder "TELECOM_HD_BOOTSTRAP_ADMIN_PASSWORD" "$ADMIN_PASS"
fi

# Bootstrap admin email must look like a real address (not *@*.example)
ADMIN_EMAIL="$(get_val TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL)"
if [[ -n "$ADMIN_EMAIL" ]]; then
  if echo "$ADMIN_EMAIL" | grep -qiE '@.*\.example$'; then
    fail "TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL — looks like a placeholder (.example domain)"
  else
    ok "TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL — does not use .example domain"
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "=============================="
TOTAL=$(( PASS + FAIL ))
echo "Results: ${FAIL} failure(s) / $((PASS + FAIL)) checks"
echo "=============================="

if (( FAIL > 0 )); then
  echo "RESULT: FAIL — fix the issues above before deploying."
  exit 1
else
  echo "RESULT: PASS — env file looks production-ready."
  exit 0
fi
