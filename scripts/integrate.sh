#!/usr/bin/env bash
# Autonomous integration barrier: waits for deps + both agents, then runs
# prisma generate/migrate, typecheck, build, and unit tests, capturing output.
# Designed to run in the background and emit a single completion summary.
set +e
cd "/Users/ihorpaschenko/Desktop/FAS Update Kayako/23-telecom-helpdesk"
LOG=scripts/integrate.log
: > "$LOG"
export DATABASE_URL="postgresql://telecom_hd:telecom_hd_dev@localhost:5432/telecom_hd?schema=public"
say() { echo "=== $* ===" | tee -a "$LOG"; }

say "WAIT deps"
until [ -x node_modules/.bin/prisma ] && [ -x node_modules/.bin/tsc ]; do sleep 5; done
say "DEPS_READY"

say "prisma generate"
node_modules/.bin/prisma generate --schema apps/api/prisma/schema.prisma >>"$LOG" 2>&1

say "prisma migrate (init)"
node_modules/.bin/prisma migrate dev --name init --schema apps/api/prisma/schema.prisma --skip-generate >>"$LOG" 2>&1
say "migrate exit=$?"

say "WAIT agents (BACKEND_NOTES + FRONTEND_NOTES)"
until [ -f apps/api/BACKEND_NOTES.md ] && [ -f apps/web/FRONTEND_NOTES.md ]; do sleep 5; done
say "AGENTS_DONE"

say "typecheck api"
( cd apps/api && ../../node_modules/.bin/tsc --noEmit ) >>"$LOG" 2>&1
say "api typecheck exit=$?"

say "typecheck web"
( cd apps/web && ../../node_modules/.bin/tsc --noEmit ) >>"$LOG" 2>&1
say "web typecheck exit=$?"

say "unit tests (api)"
( cd apps/api && ../../node_modules/.bin/vitest run ) >>"$LOG" 2>&1
say "api tests exit=$?"

say "INTEGRATION_BARRIER_DONE"
# final compact signal line
echo "INTEGRATION_BARRIER_DONE"
