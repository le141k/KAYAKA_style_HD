# 23 Telecom Help Desk — common developer tasks.
.PHONY: install infra migrate seed dev build test e2e smoke up down logs reset

install: ; npm install
infra: ; docker compose up -d postgres redis mailhog
migrate: ; npm run prisma:deploy --workspace=apps/api
seed: ; npm run seed --workspace=apps/api
dev: ; npm run dev
build: ; npm run build
test: ; npm run test
e2e: ; npm run test:e2e
smoke: ; bash scripts/smoke.sh
up: ; docker compose up --build -d
down: ; docker compose down
logs: ; docker compose logs -f --tail=100
reset: ; docker compose down -v
