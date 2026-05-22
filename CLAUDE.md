# CLAUDE.md — 23 Telecom Help Desk

Guidance for any AI/dev working in this repo. Read this first.

## What this is

Modern rewrite of the legacy **Kayako Classic** PHP helpdesk onto **NestJS + Next.js +
PostgreSQL**. Modular monolith. The original SWIFT framework is dropped; only the domain model
and behavior are carried over (reference: `../kayako_db_export/schema.sql`, `../kayako_src/`).

## Layout

```
apps/api    NestJS backend — Prisma (apps/api/prisma/schema.prisma), modules under src/modules,
            auth under src/auth, seed under src/seed
apps/web    Next.js 15 (App Router) — 3 interfaces: (client) / staff / admin
packages/shared   shared TS contracts
docs/       documentation (SEE "Living docs" below)
frontend/styles/theme   generated shadcn theme tokens
```

## Run

```bash
cp .env.example .env && docker compose up --build   # full stack, auto migrate + seed
# local dev: docker compose up -d postgres redis mailhog (host ports 55432 / 56379), then
# npm install && npm run prisma:migrate -w apps/api && npm run seed -w apps/api && npm run dev
```
Demo: `admin@23telecom.example` / `demo1234` (admin), `agent@23telecom.example` / `demo1234`.

> ⚠️ Local Postgres/Redis often occupy 5432/6379, so the compose services are published on
> **host 55432 (Postgres)** and **56379 (Redis)**. Inside the compose network they remain
> 5432/6379. `apps/api/.env` (host dev) points at the 55432/56379 ports.

## ✅ Living docs — keep these UP TO DATE

These documents are the project's source of truth. **Whenever you add, change, or remove an
endpoint, module, table, or architectural decision, update the relevant doc in the SAME change:**

| Doc | What it covers | Update when… |
|---|---|---|
| `docs/architecture.md` | system overview, modules, request flow, queues, data flow | you add/restructure a module, queue, or cross-cutting concern |
| `docs/api/endpoints.md` | every public/staff/admin REST endpoint (method, path, auth, body, response) | you add/change/remove any controller route |
| `docs/api/internal.md` | internal service contracts, domain events, queue jobs, key invariants | you add/change a service method other modules rely on, or a BullMQ job |
| `docs/adr/*` | architecture decision records | you make a non-obvious decision (add a new numbered ADR) |
| `docs/database.md` | canonical data model — all Prisma models, enums, indexes, JSONB fields, migrations, seed | you add/change/remove any model, column, index, or enum in `schema.prisma` |
| `docs/FINAL_REPORT.md` | delivery status & acceptance | at milestones / delivery |
| `PROGRESS.md` | running build status | as milestones complete |

Swagger (`/api/docs`) is generated from decorators and is authoritative for request/response
shapes; `docs/api/endpoints.md` is the human-readable index that must mirror it.

**Tip:** a dedicated "docs-keeper" agent can regenerate `architecture.md` / `endpoints.md` /
`internal.md` from the current code after a batch of changes — but the rule above (update in the
same change) is the default for small edits.

## Conventions

- TypeScript strict everywhere. Zod validation at boundaries (`ZodValidationPipe`).
- Auth: JWT access+refresh, argon2id, RBAC via `@RequirePermissions` (catalog in
  `apps/api/src/auth/permissions.ts`). Public routes use `@Public()`.
- Custom fields → JSONB (ADR-0002). Attachments by storage key (ADR-0003).
- Env vars are `TELECOM_HD_*`; DB is `telecom_hd`.
- Tests: Vitest (unit), Testcontainers (integration), Playwright (E2E), k6 (load).
