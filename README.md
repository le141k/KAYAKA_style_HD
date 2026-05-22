# 23 Telecom Help Desk

A modern, production-oriented rewrite of the legacy **Kayako Classic** helpdesk
(originally PHP on the proprietary "SWIFT" framework) onto a clean
**NestJS + Next.js + PostgreSQL** stack.

> The legacy SWIFT core (God-object, `eval()` hooks, mcrypt license gate) is **dropped**.
> Only the **domain model and behavior** are carried forward, re-derived from the original
> schema (`kayako_db_export/schema.sql`) and source (`kayako_src/`).

## Stack

| Layer         | Tech                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| Backend       | Node 22, TypeScript (strict), NestJS 10, Prisma 6, PostgreSQL 16            |
| Queues        | Redis + BullMQ (mail fetch, SLA breaches, escalations, auto-close)          |
| Mail          | imapflow + mailparser (inbound), Nodemailer (outbound)                      |
| Auth          | JWT access + refresh, argon2id password hashing, RBAC permission guards     |
| Frontend      | Next.js 15 (App Router), Tailwind, shadcn/ui, Framer Motion, TanStack Query |
| Observability | Pino structured logs, OpenTelemetry (opt-in)                                |
| API docs      | Swagger / OpenAPI at `/api/docs`                                            |
| Tests         | Vitest (unit), Testcontainers (integration), Playwright (E2E), k6 (load)    |

## Quick start (5 minutes)

```bash
git clone <repo> && cd 23-telecom-helpdesk
cp .env.example .env
docker compose up --build
```

This boots PostgreSQL, Redis, MailHog, the API, and the web app. On first boot the API
applies Prisma migrations and seeds demo data automatically.

| Service                          | URL                            |
| -------------------------------- | ------------------------------ |
| Web (client / staff / admin)     | http://localhost:3000          |
| API + Swagger                    | http://localhost:4000/api/docs |
| MailHog (captured outbound mail) | http://localhost:8025          |

### Demo credentials (seeded)

| Role          | Email                     | Password   |
| ------------- | ------------------------- | ---------- |
| Administrator | `admin@23telecom.example` | `demo1234` |
| Agent         | `agent@23telecom.example` | `demo1234` |

## Interfaces

- **/** — client portal: submit & track tickets, browse the knowledgebase.
- **/staff** — agent workspace: list + Kanban views, conversation thread, ⌘K command palette, hotkeys.
- **/admin** — configuration: departments, statuses/priorities/types, SLA, workflows/macros,
  email templates, staff & RBAC, custom fields, and the Alaris integration tab.

## Modules (functional parity targets)

`base` (users/staff/orgs/departments/RBAC/custom fields/templates) · `tickets`
(lifecycle/merge/split/audit) · `sla` (plans/breaches/escalations/working-hours) ·
`workflows` (macros/auto-actions/auto-close) · `mail` (IMAP→tickets, Message-ID threading,
outbound templates) · `knowledgebase` · `news` · `troubleshooter` · `reports`.

## Local development (without Docker)

```bash
npm install
# bring up infra only
docker compose up -d postgres redis mailhog
# api
npm run prisma:migrate --workspace=apps/api
npm run seed --workspace=apps/api
npm run dev --workspace=apps/api
# web
npm run dev --workspace=apps/web
```

## Tests

```bash
npm run test               # unit (Vitest), coverage
npm run test:integration --workspace=apps/api   # Testcontainers (Postgres + Redis)
npm run test:e2e           # Playwright E2E
```

> **No CI/CD.** This project intentionally has **no continuous-integration pipeline** — there is
> no `.github/workflows`, and GitHub Actions is disabled on the repository. All tests are run
> **locally** via the npm scripts above (Docker must be running for integration/e2e). Run them
> before committing; the Husky `pre-commit` hook runs lint-staged.

## Alaris integration (stub)

A **placeholder** module wires `POST /api/alaris/webhook` (shared-secret guarded) to
auto-create a ticket of type _Alaris Incident_ with subject prefix `[ALARIS-AUTO]`.
There is **no** SNMP polling, Telegram bridge, alarm de-duplication, or auto-close yet — the
admin UI shows a "Coming soon" tab. See `docs/adr/0005-alaris-stub.md` and
`apps/api/src/modules/alaris/`. A demo event generator lives in
`apps/api/src/seed/generate-fake-alaris-event.ts`.

## Project layout

```
apps/api          NestJS backend (Prisma schema, modules, seed, tests)
apps/web          Next.js frontend (3 interfaces, shadcn UI, premium components)
packages/shared   shared types / contracts
docs/brand        brand identity (palette, typography, tone, logo)
docs/adr          architecture decision records
frontend/styles/theme  generated shadcn theme (tokens.css, tailwind preset)
infra             ops helpers
```

See `docs/adr/` for the rationale behind key decisions.
