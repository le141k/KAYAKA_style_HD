#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Single verification GATE. "Done" is not a claim — it is `make verify` green.
#
# Runs the deterministic code gates (always) + a live smoke (if the stack is up).
# Exits non-zero if ANYTHING fails, so it can gate a "done"/merge decision.
#
#   make verify                 # gate against the current working tree + running stack
#   make reset && make up && make verify   # gate against a FRESH DB (recommended before "done")
#
# E2E (Playwright) is intentionally NOT in the core gate yet — kanban.spec.ts is
# stale (no login + old selectors). Fix those, then add `npm run test:e2e`.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NAMES=(); RESULTS=()
run() { # <name> <cmd...>
  local name="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  if "$@"; then RESULTS+=("PASS"); else RESULTS+=("FAIL"); fi
  NAMES+=("$name")
}

# ── Backend gates ──
run "api: prisma generate" npm run -s prisma:generate --workspace=apps/api
run "api: typecheck"       npm run -s typecheck       --workspace=apps/api
run "api: unit tests"      npm run -s test            --workspace=apps/api
run "api: build"           npm run -s build           --workspace=apps/api
run "api: lint"            npm run -s lint            --workspace=apps/api

# ── Frontend gates ──
run "web: typecheck"       npm run -s typecheck       --workspace=apps/web
run "web: build"           npm run -s build           --workspace=apps/web
run "web: lint"            npm run -s lint            --workspace=apps/web

# ── Live smoke (only if the stack is up) ──
if curl -fsS http://localhost:4000/api/docs-json >/dev/null 2>&1; then
  run "smoke: live stack" bash scripts/smoke.sh
else
  printf '\n\033[33m⚠ stack not up on :4000 — skipping smoke. Run `make up` first for a full gate.\033[0m\n'
fi

# ── Summary ──
printf '\n================ VERIFY SUMMARY ================\n'
fail=0
for i in "${!NAMES[@]}"; do
  if [ "${RESULTS[$i]}" = PASS ]; then
    printf '  \033[32m✓ PASS\033[0m  %s\n' "${NAMES[$i]}"
  else
    printf '  \033[31m✗ FAIL\033[0m  %s\n' "${NAMES[$i]}"; fail=1
  fi
done
printf '================================================\n'
if [ "$fail" = 0 ]; then
  printf '\033[32m✅ VERIFY GREEN — gate passed\033[0m\n'
else
  printf '\033[31m❌ VERIFY RED — NOT done\033[0m\n'; exit 1
fi
