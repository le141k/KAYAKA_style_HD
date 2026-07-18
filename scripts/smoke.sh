#!/usr/bin/env bash
# Developer-stack authentication smoke. It intentionally uses the local seed
# account, but follows the production cookie-only + signed CSRF contract.
set -euo pipefail
umask 077

API_URL="${API_URL:-http://localhost:4000}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost:3000}"
STAFF_EMAIL="${SMOKE_STAFF_EMAIL:-admin@23telecom.example}"
STAFF_PASSWORD="${SMOKE_STAFF_PASSWORD:-demo1234}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required'

API_URL="${API_URL%/}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN%/}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/telecom-hd-dev-smoke.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM
COOKIE_JAR="$WORK_DIR/cookies.txt"
BODY="$WORK_DIR/body.json"
CSRF_HEADERS="$WORK_DIR/csrf-headers.txt"
: > "$COOKIE_JAR"

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '%s' "$value"
}

cookie_value() {
  local name="$1"
  awk -F '\t' -v wanted="$name" 'NF >= 7 && $6 == wanted { value = $7 } END { print value }' "$COOKIE_JAR" 2>/dev/null
}

write_csrf_headers() {
  local token
  token="$(cookie_value 'th_csrf')"
  [[ -n "$token" ]] || token="$(cookie_value '__Host-th_csrf')"
  [[ -n "$token" ]] || fail 'Signed CSRF cookie was not issued'
  printf 'Origin: %s\nx-csrf-token: %s\n' "$PUBLIC_ORIGIN" "$token" > "$CSRF_HEADERS"
}

CURL=(
  curl --silent --show-error --connect-timeout 5 --max-time 20
  --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR"
  --output "$BODY" --write-out '%{http_code}'
)

printf '→ API health\n'
STATUS="$("${CURL[@]}" "$API_URL/api/health")" || fail 'API is not reachable'
[[ "$STATUS" == 200 ]] || fail "API health returned HTTP $STATUS"
pass 'API healthy'

printf '→ Cookie-only staff session\n'
LOGIN_JSON="{\"email\":\"$(json_escape "$STAFF_EMAIL")\",\"password\":\"$(json_escape "$STAFF_PASSWORD")\"}"
STATUS="$(printf '%s' "$LOGIN_JSON" | "${CURL[@]}" \
  --request POST "$API_URL/api/auth/login" \
  --header "Origin: $PUBLIC_ORIGIN" \
  --header 'Content-Type: application/json' \
  --data-binary @-)" || fail 'Login request failed'
unset LOGIN_JSON STAFF_PASSWORD
[[ "$STATUS" == 200 ]] || fail "Login returned HTTP $STATUS"
grep -q '"staff"' "$BODY" || fail 'Login response did not contain staff'
if grep -Eq '"(accessToken|refreshToken)"' "$BODY"; then
  fail 'Login response leaked a bearer token in JSON'
fi
[[ -n "$(cookie_value 'th_access')" ]] || fail 'Dev access cookie was not issued'
[[ -n "$(cookie_value 'th_refresh')" ]] || fail 'Dev refresh cookie was not issued'
write_csrf_headers
pass 'login cookies and CSRF token issued'

STATUS="$("${CURL[@]}" \
  --request POST "$API_URL/api/auth/refresh" \
  --header "@$CSRF_HEADERS")" || fail 'Refresh request failed'
[[ "$STATUS" == 200 ]] || fail "Refresh returned HTTP $STATUS"
if grep -Eq '"(accessToken|refreshToken)"' "$BODY"; then
  fail 'Refresh response leaked a bearer token in JSON'
fi
write_csrf_headers
pass 'refresh cookie rotated'

STATUS="$("${CURL[@]}" "$API_URL/api/auth/me")" || fail 'Principal request failed'
[[ "$STATUS" == 200 ]] || fail "Principal returned HTTP $STATUS"
pass 'cookie-authenticated principal returned'

STATUS="$("${CURL[@]}" \
  --request POST "$API_URL/api/auth/logout" \
  --header "@$CSRF_HEADERS")" || fail 'Logout request failed'
[[ "$STATUS" == 204 ]] || fail "Logout returned HTTP $STATUS"

STATUS="$("${CURL[@]}" "$API_URL/api/auth/me")" || fail 'Post-logout check failed'
[[ "$STATUS" == 401 ]] || fail "Logged-out session remained valid (HTTP $STATUS)"
pass 'logout revoked the session'

printf 'All developer smoke checks passed.\n'
