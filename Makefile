# 23 Telecom Help Desk — common developer tasks.
.PHONY: install infra migrate seed audit-production audit-attachments audit-live dev build test e2e smoke smoke-prod up down logs reset verify verify-full

install: ; npm install
infra: ; docker compose up -d postgres redis mailhog
migrate: ; npm run prisma:deploy --workspace=apps/api
seed: ; npm run seed --workspace=apps/api
audit-production: ; npm run audit:production --workspace=apps/api
audit-attachments: ; npm run audit:attachments --workspace=apps/api
audit-live: audit-production audit-attachments
dev: ; npm run dev
build: ; npm run build
test: ; npm run test
e2e: ; npm run test:e2e
smoke: ; bash scripts/smoke.sh
smoke-prod: ; bash scripts/smoke-prod.sh
verify: ; bash scripts/verify.sh   # the GATE: tsc+vitest+build+lint+smoke, one PASS/FAIL
# Strongest gate: the standard verify PLUS the full Playwright e2e (needs the stack up).
verify-full: ; bash scripts/verify.sh && npm run test:e2e
up: ; docker compose up --build -d
down: ; docker compose down
logs: ; docker compose logs -f --tail=100
reset: ; docker compose down -v
