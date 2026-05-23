#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up).
# Verifies: health, staff login, ticket create via public API, alaris webhook → ticket.
set -euo pipefail

API="${API_URL:-http://localhost:4000}"
# Default must match the dev .env / config default, else the webhook check 403s.
SECRET="${TELECOM_HD_ALARIS_WEBHOOK_SECRET:-alaris-dev-secret-change-me-0000}"
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }

echo "→ Swagger reachable"
curl -fsS "$API/api/docs-json" >/dev/null && pass "OpenAPI served" || fail "Swagger not reachable"

echo "→ Staff login"
TOKEN=$(curl -fsS -X POST "$API/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@23telecom.example","password":"demo1234"}' \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] && pass "logged in, got access token" || fail "login failed"

echo "→ Create ticket via public API"
TID=$(curl -fsS -X POST "$API/api/tickets/public" \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Smoke test","requesterEmail":"smoke@example.com","requesterName":"Smoke","contents":"hello"}' \
  | sed -n 's/.*"mask":"\([^"]*\)".*/\1/p')
[ -n "$TID" ] && pass "ticket created: $TID" || fail "ticket creation failed"

echo "→ Alaris webhook → ticket"
AMASK=$(curl -fsS -X POST "$API/api/alaris/webhook" \
  -H 'Content-Type: application/json' -H "x-alaris-secret: $SECRET" \
  -d '{"externalId":"smoke-'"$RANDOM"'","severity":"critical","message":"Trunk down"}' \
  | sed -n 's/.*"mask":"\([^"]*\)".*/\1/p')
[ -n "$AMASK" ] && pass "alaris ticket created: $AMASK" || fail "alaris webhook failed"

echo "All smoke checks passed."
