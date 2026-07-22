# Architecture — 23 Telecom Help Desk

> Living doc — keep current (see `CLAUDE.md` → "Living docs"). Sections marked _(auto)_ are
> regenerated from code by the docs-keeper agent; prose sections are maintained by hand.

## 1. Overview

Modular monolith. A NestJS API exposes a REST surface (Swagger at `/api/docs`) backed by
PostgreSQL (Prisma) and Redis (BullMQ — implemented). A Next.js App Router frontend
renders three audiences (client / staff / admin) against that API.

```
                ┌────────────┐      REST/JSON      ┌──────────────────────┐
   Browser ───▶ │  Next.js   │ ──────────────────▶ │   NestJS API (4000)  │
  (3 UIs)       │  web (3000)│ ◀────────────────── │  /api, /api/docs     │
                └────────────┘                     └─────────┬────────────┘
                                                             │ Prisma
   Inbound mail (IMAP) ─▶ InboundMailService ─▶ tickets       ▼
   Outbound mail ◀─ nodemailer ◀─ MailService  ┌──────────────┐  ┌──────────────┐
   Alaris webhook ─▶ AlarisService ─▶ tickets  │ PostgreSQL 16│  │ Redis        │
   EventEmitter2 ─▶ WorkflowExecutor           └──────────────┘  │ BullMQ       │
   BullMQ sla/workflow/mail queues                                │ queues: sla, │
                                                                  │ workflow,    │
                                                                  │ mail         │
                                                                  └──────────────┘
```

## 2. Modules _(auto — read from apps/api/src/app.module.ts)_

The following modules are registered in `AppModule` (the authoritative list):

| Module                 | Location                      | Responsibility                                                                                                                                                                                     |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrismaModule`         | `src/prisma/`                 | Global DB access via PrismaService                                                                                                                                                                 |
| `AuthModule`           | `src/auth/`                   | Login/refresh/logout, JWT issuance, RBAC guards (`JwtAuthGuard`, `PermissionsGuard`), session revocation (`SessionRevocationService` + Redis access cutoff)                                        |
| `StaffModule`          | `src/modules/staff/`          | Staff members and staff groups (Administrator/Manager/Agent roles); RBAC catalog (`/staff/rbac`), audit log (`RbacAuditService`, `/staff/audit`); last-admin guards; soft-delete (isEnabled=false) |
| `UsersModule`          | `src/modules/users/`          | End-user profiles; multi-email management (primary + extras)                                                                                                                                       |
| `OrganizationsModule`  | `src/modules/organizations/`  | Client organizations; links to SLA plans                                                                                                                                                           |
| `DepartmentsModule`    | `src/modules/departments/`    | Self-referential department tree; flat + nested views                                                                                                                                              |
| `TicketsModule`        | `src/modules/tickets/`        | Full ticket lifecycle: create, reply, note, assign, status/priority/type change, merge, watchers, tags, audit log; reference data (statuses, priorities, types)                                    |
| `AlarisModule`         | `src/modules/alaris/`         | Alaris monitoring webhook → auto-ticket creation (shared-secret, deduplication)                                                                                                                    |
| `SlaModule`            | `src/modules/sla/`            | SLA plans/schedules/holidays/escalation-rules CRUD + admin HTTP routes; working-hours due-date calc; breach detection; escalation action executor; BullMQ `sla` queue + `SlaProcessor`             |
| `MailModule`           | `src/modules/mail/`           | Inbound IMAP/PIPE durable ledger plus SMTP. A staff reply creates `OutboundEmail` atomically with its post; BullMQ carries only its id and DB recovery scans authoritative rows after restart.     |
| `NewsModule`           | `src/modules/news/`           | Staff-managed news items; public read, staff write                                                                                                                                                 |
| `KnowledgebaseModule`  | `src/modules/knowledgebase/`  | Articles, categories, revision history; public read for published, staff write                                                                                                                     |
| `ReportsModule`        | `src/modules/reports/`        | Dashboard metrics + stored reports (KQL-lite aggregation over ticket-derived sources); each run is SQL-scoped to the caller's departments and schedules execute only under their live owner        |
| `TroubleshooterModule` | `src/modules/troubleshooter/` | Branching troubleshooting guides: categories → steps → step links                                                                                                                                  |
| `WorkflowModule`       | `src/modules/workflow/`       | Workflow/Macro/MacroCategory CRUD + admin HTTP routes; `WorkflowExecutor` (EventEmitter2 listeners); `AutoCloseProcessor` (BullMQ `workflow` queue)                                                |
| `AdminModule`          | `src/modules/admin/`          | Custom field group/field CRUD + `validateCustomFields()` cross-module helper; email template CRUD                                                                                                  |

All 16 modules above are registered in `AppModule` and serve live routes (verified responding).

## 3. Request lifecycle

```
HTTP Request
  → NestJS Router (global prefix: /api)
  → CsrfGuard  (cookie-authenticated unsafe methods require exact Origin/Referer plus a matching,
     HMAC-signed double-submit cookie / `X-CSRF-Token`; login/refresh/client-verify require exact
     origin even before a cookie exists; explicit Bearer and shared-secret webhooks bypass — S3-5)
  → JwtAuthGuard  (checks @Public(); else verifies Bearer/cookie JWT, then loads the CURRENT
     Staff+group from DB and checks isEnabled + authVersion (`av` claim) — so disable/password/
     group changes and logout-all revoke access immediately; fails closed 503 if DB is down.
     Derives fresh permissions from the DB group and attaches AuthStaff to req.user — S3-1)
  → PermissionsGuard  (checks @RequirePermissions(...); admins bypass all checks)
  → TicketAccessPolicy (staff ticket boundaries only: only a global administrator is unrestricted;
     every non-admin needs explicit DepartmentStaff rows and every ticket predicate is constrained
     in SQL to those assigned departments. Cross-department detail/mutation/download returns
     the same 404 as a missing resource. Bulk validates the complete set before writing; links and
     merges require access to both tickets; a department move and assignment validate the target
     department. Trusted inbound/client/system flows do not impersonate a staff actor.)
  → ZodValidationPipe  (validates + transforms body/query via Zod schema)
  → Controller method
  → Service (business logic + Prisma)
  → GlobalExceptionFilter  (normalizes errors to JSON { statusCode, message })
  → Pino HTTP logger  (structured JSON request logs — strict allowlist: method, path
     without query, status, duration, request id, trusted client IP only; every header
     and body dropped so credentials/tokens never leak. See apps/api/src/config/logging.ts)
```

Public routes (bypass JWT): `POST /auth/login`, `POST /auth/refresh`,
`POST /tickets/public`, `POST /alaris/webhook` (but checks shared-secret header),
`GET /news`, `GET /kb/articles`, `GET /kb/articles/slug/:slug`, `GET /kb/categories`,
`POST /client-auth/request-link`, `POST /client-auth/verify`.

**Staff browser auth is cookie-only.** Login returns `{staff}` and refresh returns `{ok:true}`;
raw JWTs never enter browser JSON. Production uses host-only `__Host-th_access` (`Path=/`) and
`__Host-th_refresh` (`Path=/`), both Secure/HttpOnly/SameSite=Lax. The root path is required by the
`__Host-` cookie contract and lets a refresh-only hard navigation recover through `/auth/me`.
Logout and every invalid refresh clear current and legacy names/paths, including the former
`__Secure-th_refresh` narrow-path cookie. Bearer validation remains only for explicit external/test
clients; the application does not issue browser tokens in JSON.

**Client (customer) auth mode (S2).** Distinct from staff JWT: a magic-link
(`request-link` → single-use hashed token → `verify`) opens a hashed `ClientSession`
behind an HttpOnly `th_client` cookie, bound to a stable `User.id`. Routes decorated
`@ClientAuthenticated()` (= `@Public()` + `ClientAuthGuard`) resolve `req.client = {userId}`;
client ticket routes (`/tickets/my`, `/tickets/public/:id`, `.../reply`) authorize strictly
by `Ticket.userId === client.userId`. Never reuses staff JWT/RBAC identity.
Frontend (S2-9): the emailed link lands on the `/verify` page (route group `(client)`, served at
root), which strips the `#token=` fragment via `history.replaceState`, POSTs it, and is rendered
`referrer: no-referrer`. The customer portal (`use-client-auth` / `use-client-tickets`) talks to
`/client-auth/*` and the client ticket routes through a raw-fetch `clientFetch` (cookie-included,
separate from the staff `api` client) — no `?email=` and no `localStorage` identity remain.

**Login-abuse throttle (S3-7).** `POST /auth/login` carries the per-IP `@Throttle(5/60s)` plus a
`LoginThrottleService` Redis counter keyed by trusted client IP + `HMAC-SHA256(email)`: a generic
**429** after 10 failures in a 15-min sliding window, cleared on success. It never locks an account
(the key is per-IP, so a known account stays reachable from other IPs) and the raw email is never
stored. Fail-open — a Redis outage falls back to the per-IP throttle. Both the 429 and the
credential failure are generic, disclosing nothing about account existence or lock state.

## 4. Background jobs _(auto)_

### Implemented — BullMQ queues

`BullModule.forRoot()` is registered in `AppModule` with Redis connection from `REDIS_URL`.

| Component                   | Mechanism                                                                                                                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InboundMailService`        | `setInterval` (60 s single-flight poll + 30 s single-flight drain + startup drain + hourly raw-MIME maintenance), `OnModuleInit` | Durable, fail-closed inbound ledger. IMAP acceptance is fenced by queue epoch/generation/UIDVALIDITY and cursor CAS; PIPE authenticates before bounded byte parsing and requires an enabled PIPE queue + hashed delivery id. Lease/heartbeat drain creates or threads ticket work transactionally, then retries or quarantines without discard. Logical Message-ID claims use semantic content; headerless mail is transport-identity based. Large raw MIME uses the existing uploads volume with atomic staging/marker cleanup; truncated MIME is quarantined and replay-blocked. |
| `EmailQueueService`         | `setInterval` (5 min health alerts), `OnModuleInit`                                                                              | Returns safe per-queue liveness, backlog/quarantine bytes/raw-storage reserve and alerts; logs critical halt/collision conditions. Reconcile/replay are permissioned, reasoned and transactionally audited operator actions.                                                                                                                                                                                                                                                                                                                                                       |
| `SlaProcessor`              | BullMQ queue `sla`, repeatable `scan` job (60 s)                                                                                 | Calls `SlaService.runPeriodicCheck()` → serializable breach-event claim → current-rule/action execution. Staff alerts are immutable `INTERNAL_NOTIFICATION` outbox commands in the same transaction; stale rule/recipient checks fail closed.                                                                                                                                                                                                                                                                                                                                      |
| `WorkflowEmailEventService` | PostgreSQL recovery scan (30 s) + health alert scan (5 min), `OnModuleInit`                                                      | Drains immutable workflow-email snapshots with a lease and action-level idempotency. Quarantines malformed/stale-recipient events; ticket-scoped operators can inspect and CAS-replay safe events from `/admin/mail`.                                                                                                                                                                                                                                                                                                                                                              |
| `AutoCloseProcessor`        | BullMQ queue `workflow`, repeatable `auto-close` job                                                                             | Closes pending tickets idle > `TELECOM_HD_AUTO_CLOSE_DAYS` days (default 7) and creates one durable `AUTO_CLOSE` command using `ticket_auto_closed`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MailProcessor`             | BullMQ queue `mail`, per-job                                                                                                     | Claims durable `OutboundEmail` rows using a DB lease/fence, streams immutable attachment snapshots to Nodemailer and marks `SENT` only after SMTP accepts. It delivers staff replies, customer automation, workflow/report results and internal staff alerts; PostgreSQL recovery is authoritative.                                                                                                                                                                                                                                                                                |

### Implemented — EventEmitter2

`EventEmitterModule.forRoot()` is registered in `AppModule`. `TicketsService` emits typed events
(`ticket.created`, `ticket.replied`, `ticket.status_changed`) consumed by `WorkflowExecutor`
via `@OnEvent` decorators.

### Remaining TODOs

- **SLA criteria engine**: plan selection beyond org-based lookup is TODO.
- **Attachment upload**: `Attachment` model exists; no upload endpoint or storage adapter.
- **IMAP IDLE**: replace polling with push-based IMAP IDLE.
- **Public ticket rate-limiting**: `POST /tickets/public` — use `@nestjs/throttler`.
- **Frontend staff auth**: JWT-only; no cookie session.

## 5. Data model

See `apps/api/prisma/schema.prisma` and:

- ADR-0002: custom fields → JSONB
- ADR-0003: attachments storage strategy
