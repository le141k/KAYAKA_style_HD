#!/usr/bin/env bash
# Non-destructive production authentication smoke.
# Required environment:
#   SMOKE_BASE_URL=https://help.company.tld
#   SMOKE_STAFF_EMAIL=<approved temporary real staff account>
#   SMOKE_STAFF_PASSWORD=<that account's password>
# The script never prints credentials, cookies, CSRF values, JWTs or response bodies.
set -euo pipefail
umask 077

BASE_URL="${SMOKE_BASE_URL:-}"
STAFF_EMAIL="${SMOKE_STAFF_EMAIL:-}"
STAFF_PASSWORD="${SMOKE_STAFF_PASSWORD:-}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[[ -n "$BASE_URL" ]] || fail 'SMOKE_BASE_URL is required'
[[ -n "$STAFF_EMAIL" ]] || fail 'SMOKE_STAFF_EMAIL is required'
[[ -n "$STAFF_PASSWORD" ]] || fail 'SMOKE_STAFF_PASSWORD is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v awk >/dev/null 2>&1 || fail 'awk is required'

BASE_URL="${BASE_URL%/}"
if [[ "$BASE_URL" != https://* ]] ||
   [[ "${BASE_URL#https://}" == *'/'* ]] ||
   [[ "$BASE_URL" =~ (localhost|127\.0\.0\.1|\[::1\]) ]]; then
  fail 'SMOKE_BASE_URL must be a canonical non-local HTTPS origin'
fi
if printf '%s' "$STAFF_EMAIL" | grep -qiE '(^admin@23telecom\.example$|@.*\.example$|@example\.(com|net|org)$)'; then
  fail 'Use an approved real temporary staff account, not a shipped/demo identity'
fi
[[ "$STAFF_PASSWORD" != demo1234 ]] || fail 'Use a real temporary account password, not the demo password'

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/telecom-hd-smoke.XXXXXX")"
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

csrf_value() {
  local value
  value="$(cookie_value '__Host-th_csrf')"
  [[ -n "$value" ]] || value="$(cookie_value 'th_csrf')"
  printf '%s' "$value"
}

write_csrf_headers() {
  local token
  token="$(csrf_value)"
  [[ -n "$token" ]] || fail 'Signed CSRF cookie was not issued'
  printf 'Origin: %s\nx-csrf-token: %s\n' "$BASE_URL" "$token" > "$CSRF_HEADERS"
}

CURL=(
  curl --silent --show-error
  --proto '=https' --tlsv1.2
  --connect-timeout 10 --max-time 30
  --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR"
  --output "$BODY" --write-out '%{http_code}'
)

printf '→ Production smoke against %s\n' "$BASE_URL"

if ! STATUS="$("${CURL[@]}" "$BASE_URL/login")"; then
  fail 'Login page request failed'
fi
[[ "$STATUS" == 200 ]] || fail "Login page returned HTTP $STATUS"
pass 'HTTPS login page reachable'

LOGIN_JSON="{\"email\":\"$(json_escape "$STAFF_EMAIL")\",\"password\":\"$(json_escape "$STAFF_PASSWORD")\"}"
if ! STATUS="$(printf '%s' "$LOGIN_JSON" | "${CURL[@]}" \
  --request POST "$BASE_URL/api/auth/login" \
  --header "Origin: $BASE_URL" \
  --header 'Content-Type: application/json' \
  --data-binary @-)"; then
  fail 'Staff login request failed'
fi
unset LOGIN_JSON STAFF_PASSWORD
[[ "$STATUS" == 200 ]] || fail "Staff login returned HTTP $STATUS"
grep -q '"staff"' "$BODY" || fail 'Staff login response did not contain the safe staff principal'
if grep -Eq '"(accessToken|refreshToken)"' "$BODY"; then
  fail 'Staff login response leaked a bearer token in JSON'
fi
[[ -n "$(cookie_value '__Host-th_access')" ]] || fail 'Production access cookie was not issued'
[[ -n "$(cookie_value '__Host-th_refresh')" ]] || fail 'Production refresh cookie was not issued'
write_csrf_headers
pass 'Cookie-only staff login and signed CSRF cookie verified'

if ! STATUS="$("${CURL[@]}" \
  --request POST "$BASE_URL/api/auth/refresh" \
  --header "@$CSRF_HEADERS")"; then
  fail 'Cookie refresh request failed'
fi
[[ "$STATUS" == 200 ]] || fail "Cookie refresh returned HTTP $STATUS"
grep -q '"ok"' "$BODY" || fail 'Cookie refresh response did not acknowledge rotation'
if grep -Eq '"(accessToken|refreshToken)"' "$BODY"; then
  fail 'Cookie refresh response leaked a bearer token in JSON'
fi
write_csrf_headers
pass 'Refresh-cookie rotation with CSRF header verified'

if ! STATUS="$("${CURL[@]}" "$BASE_URL/api/auth/me")"; then
  fail 'Authenticated principal request failed'
fi
[[ "$STATUS" == 200 ]] || fail "Authenticated principal returned HTTP $STATUS"
if grep -Eq '"(jti|passwordHash|refreshToken|accessToken)"' "$BODY"; then
  fail 'Authenticated principal response exposed an internal credential field'
fi
pass 'Cookie-authenticated principal endpoint verified'

if ! STATUS="$("${CURL[@]}" \
  --request POST "$BASE_URL/api/auth/logout" \
  --header "@$CSRF_HEADERS")"; then
  fail 'Logout request failed'
fi
[[ "$STATUS" == 204 ]] || fail "Logout returned HTTP $STATUS"
pass 'CSRF-protected logout verified'

if ! STATUS="$("${CURL[@]}" "$BASE_URL/api/auth/me")"; then
  fail 'Post-logout session check request failed'
fi
[[ "$STATUS" == 401 ]] || fail "Revoked session remained usable (HTTP $STATUS)"
pass 'Logged-out session is rejected'

printf '\033[32mProduction smoke passed.\033[0m No business records were created or modified.\n'
