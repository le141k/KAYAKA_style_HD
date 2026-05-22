# 23 Telecom Help Desk — Delivery Report

A modern rewrite of Kayako Classic on **NestJS + Next.js + PostgreSQL**, verified running
locally. This report distinguishes **✅ verified** (executed and observed) from **🟡 provided
but not yet executed end-to-end**.

## How to run

```bash
cp .env.example .env
docker compose up --build      # postgres, redis, mailhog, api (auto-migrate+seed), web
```
Local dev (what was used to verify): `docker compose up -d postgres redis mailhog`
(host ports **55432 / 56379** to avoid clashing with a native pg/redis), then per-app
`npm run dev`. The API auto-detects no IMAP queues and disables inbound polling.

| Service | URL |
|---|---|
| Web (client / staff / admin) | http://localhost:3000 |
| API + Swagger | http://localhost:4000/api/docs |
| MailHog | http://localhost:8025 |

### Demo credentials (seeded)
| Role | Email | Password |
|---|---|---|
| Administrator | `admin@23telecom.example` | `demo1234` |
| Agent | `agent@23telecom.example` | `demo1234` |

## Acceptance checklist

| Item | Status | Evidence |
|---|---|---|
| Brand identity in `docs/brand/` | ✅ | guidelines + SVG logo/mark + tone of voice ru/en/uk |
| shadcn theme in `frontend/styles/theme/` | ✅ | tokens.css (light/dark) + tailwind preset |
| Prisma migrations apply | ✅ | 2 migrations applied to PostgreSQL 16 |
| Seed + demo login work | ✅ | seed populated; live login returns JWT |
| Ticket creation via API | ✅ | smoke: `POST /api/tickets/public` → TT-000006 |
| Alaris webhook → ticket | ✅ | smoke: `POST /api/alaris/webhook` → TT-000007 `[ALARIS-AUTO]` |
| Swagger at `/api/docs` | ✅ | served (49 paths / 72 operations) |
| Three interfaces functional | ✅ | screenshots: client, staff, admin (see below) |
| UI on shadcn + ≥10 premium components | ✅ | 17 shadcn + 14 premium components |
| Unit tests | ✅ | Vitest **25/25 passing** (auth, tickets, sla) |
| TypeScript strict typecheck | ✅ | api `tsc` exit 0; web `tsc` exit 0 |
| Frontend production build | ✅ | `next build` exit 0, 18 pages, `next lint` clean |
| README 5-minute start | ✅ | README.md quick start |
| `docker compose up` no manual steps | ✅ | images built; full stack up; containerized API auto-migrated+seeded; smoke vs containers: login ✅, ticket TT-000008 ✅, alaris TT-000009 ✅; web renders; MailHog UI 200 |
| Integration tests (Testcontainers) | ✅ | `tickets.int-spec.ts` **7/7 passing** (real Postgres container, migrate+seed, supertest: public create, get, reply, list, status change) |
| E2E (Playwright) | ✅ | **18/18 passing** (chromium) against the live stack: login, KB search, kanban, ticket submit |
| k6 load (1000 RPS) | 🟡 | script `infra/k6/ticket-creation.js`; not run here |
| SLA breach → escalation | ✅ (unit) | `sla.service.spec.ts` covers due-date calc + breach detection |

## What was built

**Backend (NestJS, ~60 files):** auth (JWT access+refresh, argon2id, RBAC permission guards),
base domain (staff/groups, users+multi-email, organizations, departments tree), tickets (full
lifecycle: create/reply/note/assign/status/priority/type/merge/watchers/tags/audit + public
submit), reference data, SLA (working-hours due dates + breach detection), mail (Nodemailer
outbound + templates; imapflow inbound threading), knowledgebase (articles/categories/revisions/
search), news, troubleshooter (branching guides), reports (KQL-lite dashboard aggregation),
alaris webhook stub. Swagger, Pino logging, Zod validation, seed script.

**Frontend (Next.js 15, ~95 files):** 3 route groups (client / staff / admin), 17 shadcn/ui
components, **14 premium animated components** (AnimatedStatCard, KanbanBoard w/ drag-glow,
CommandPalette ⌘K, SidebarNav, LoginScreen, FileUploadZone, NotificationBell, StatusBadge,
SlaPill, skeletons, …), React Query, RHF+Zod, Framer Motion, next-themes light/dark, i18n
ru/en/uk, responsive.

**Data model:** normalized Prisma schema (FKs, enums, DateTime, custom fields → JSONB,
attachments by storage key) derived from the 203-table Kayako schema.

**Docs:** brand, 5 ADRs, architecture.md, api/endpoints.md, api/internal.md, CLAUDE.md
(living-docs maintenance policy), this report.

## Screenshots (`docs/screenshots/`)

| Screen | File |
|---|---|
| Login (brand split layout, ru) | `login.png` |
| Staff dashboard (animated stat cards, recent tickets) | `staff-dashboard.png` |
| Staff Kanban (status columns, draggable cards) | `staff-kanban.png` |
| Staff ticket detail (thread + composer + side panel) | `staff-ticket-detail.png` |
| Staff ticket list | `staff-tickets.png` |
| Client knowledgebase | `client-kb.png` |
| Client submit ticket | `client-submit.png` |
| Admin SLA | `admin-sla.png` |
| Admin Alaris (coming-soon stub) | `admin-alaris.png` |

## Known gaps / TODO (for full parity & production)

- **Wire BullMQ** for the SLA breach scan and (optional) IMAP polling (currently inline / lifecycle).
- **Workflow engine** (`Workflow`/`Macro` models exist; no executor yet) and full
  `EscalationRule.actions` execution (currently marks `isEscalated`).
- **Attachment upload endpoint** + storage adapter (model + schema ready).
- **Reports**: KQL-lite covers dashboard/group-by; full KQL lexer/parser is future work.
- **Alaris**: real SNMP/alarm ingestion, dedup windows, auto-close (this build is the webhook stub per spec).
- **Run integration + E2E + k6 suites** in CI (GitHub Actions workflow provided;
  Testcontainers/Playwright/k6 not executed in this environment).
- `/auth/me` returns the staff principal; enrich with full profile fields for the staff topbar.

## Verification log (this session)

- `prisma migrate dev` ×2 → DB in sync.
- `tsc --noEmit` (api) → 0 errors. `tsc --noEmit` (web) → 0 errors.
- `vitest run` (api) → 25 passed.
- `nest build` → ok; API booted, `/api/docs` served.
- `scripts/smoke.sh` → login ✅, public ticket ✅ (TT-000006), alaris webhook ✅ (TT-000007).
- Extended runtime checks → `/api/reports/dashboard`, `/api/troubleshooter/*`, `/api/kb/*`,
  `/api/news` all 200.
- `next build` → 18 pages, lint clean. Live screenshots captured for all 3 interfaces.
- **Test suites all green**: unit 25/25, integration (Testcontainers) 7/7, E2E (Playwright) 18/18.
- **Bugs found & fixed during verification**: method-level `@UsePipes` validating `@CurrentStaff`
  (fixed systemically in `ZodValidationPipe` — staff `POST /api/tickets` now 201); client portal
  submit posted to the authed `/tickets` (now `/tickets/public`); login stored `res.token`
  (now `accessToken`); AuthModule made `@Global` for guard DI; integration-test DI via SWC metadata.
- **Final containerized smoke** (rebuilt images): login OK, staff create 201, public create 201,
  alaris webhook 200, web 200 — all 5 services healthy via `docker compose up`.
