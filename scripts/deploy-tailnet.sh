#!/usr/bin/env bash
# One-shot tailnet deploy for the 23 Telecom Help Desk (portal on :1488, HTTP, tailnet-only).
#
# Run on the help-desk VM, from the repo root, as the service user (in the docker group):
#   ./scripts/deploy-tailnet.sh
#
# Steps: validate .env.prod → build+launch prod stack + tailnet proxy (:1488) →
# wait for /api/health. The api container itself runs `migrate deploy` + bootstrap-admin
# on start (see docker-compose.prod.yml). Idempotent: re-running updates in place.
#
# Firewall (infra/nftables/helpdesk.nft) is NOT applied here — apply it separately
# and carefully (SSH-lockout risk); see that file's header.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ENV_FILE="${ENV_FILE:-.env.prod}"
COMPOSE=(docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file "$ENV_FILE")

echo "[deploy-tailnet] 1/4 preflight validating ${ENV_FILE}…"
bash scripts/preflight.sh "$ENV_FILE"

echo "[deploy-tailnet] 2/4 building + starting stack (prod + tailnet :1488)…"
"${COMPOSE[@]}" up -d --build

echo "[deploy-tailnet] 3/4 waiting for the API to become healthy…"
for i in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T api wget -qO- http://localhost:4000/api/health >/dev/null 2>&1; then
    echo "[deploy-tailnet] API healthy."
    break
  fi
  [ "$i" -eq 60 ] && {
    echo "[deploy-tailnet] ERROR: API did not become healthy in time. Check: ${COMPOSE[*]} logs api" >&2
    exit 1
  }
  sleep 3
done

echo "[deploy-tailnet] 4/4 verifying the portal on :1488…"
if curl -fsS -o /dev/null http://127.0.0.1:1488/login; then
  echo "[deploy-tailnet] Portal responding on :1488."
else
  echo "[deploy-tailnet] WARNING: :1488 not responding yet — check: ${COMPOSE[*]} logs proxy" >&2
fi

TIP="$(ip -4 -o addr show tailscale0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 || true)"
echo
echo "[deploy-tailnet] Done. Reach the portal over the tailnet/LAN at:"
[ -n "$TIP" ] && echo "    http://${TIP}:1488"
echo "    http://10.0.0.20:1488"
echo "Reminder: apply infra/nftables/helpdesk.nft (with a rollback timer) to gate :1488/:22 to the tailnet."
