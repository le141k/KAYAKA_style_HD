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
| `MailModule`           | `src/modules/mail/`           | Outbound (nodemailer SMTP + DB templates); inbound IMAP polling → ticket threading; BullMQ `mail` queue + `MailProcessor`                                                                          |
| `NewsModule`           | `src/modules/news/`           | Staff-managed news items; public read, staff write                                                                                                                                                 |
| `KnowledgebaseModule`  | `src/modules/knowledgebase/`  | Articles, categories, revision history; public read for published, staff write                                                                                                                     |
| `ReportsModule`        | `src/modules/reports/`        | Dashboard metrics + stored reports (KQL-lite aggregation over tickets)                                                                                                                             |
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

| Component            | Mechanism                                                                                      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InboundMailService` | `setInterval` (60 s poll + 30 s drain + startup drain + hourly raw-MIME prune), `OnModuleInit` | Durable, fail-closed inbound via the `InboundDelivery` ledger: accepts each IMAP/PIPE message (raw MIME) under a unique transport key, advances the `EmailQueue` UID cursor only on durable acceptance (monotonic CAS), then drains ACCEPTED/RETRY deliveries under a **lease** (heartbeat-extended, 0-row settle detects a lost lease) → thread/create ticket, with retry→quarantine (never discards). Content-aware Message-ID dedup (same-id/different-content → quarantine), truncated-fetch fast-quarantine, sender-authorized RFC/mask threading, bounded MIME parsing, sync bootstrap barrier at connect, fail-closed UIDVALIDITY halt, per-queue liveness stamps, and a raw-MIME retention prune (`TELECOM_HD_INBOUND_RAW_RETENTION_DAYS`, default 30) |
| `EmailQueueService`  | `setInterval` (5 min health alerts), `OnModuleInit`                                            | Runs the inbound health snapshot and logs alerts (halted queue = critical; quarantine / stalled-lease / aged-backlog = warning) so operators see problems without polling `GET /admin/email-queues/inbound/health`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SlaProcessor`       | BullMQ queue `sla`, repeatable `scan` job (60 s)                                               | Calls `SlaService.runPeriodicCheck()` → breach detection → escalation action execution (notify, priority change, assign, add note)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AutoCloseProcessor` | BullMQ queue `workflow`, repeatable `auto-close` job                                           | Closes pending tickets idle > `TELECOM_HD_AUTO_CLOSE_DAYS` days (default 7); sends `autoresponder` mail template                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MailProcessor`      | BullMQ queue `mail`, per-job                                                                   | Async outbound mail delivery via `MailService`/nodemailer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Implemented — EventEmitter2

`EventEmitterModule.forRoot()` is registered in `AppModule`. `TicketsService` emits typed events
(`ticket.created`, `ticket.replied`, `ticket.status_changed`) consumed by `WorkflowExecutor`
via `@OnEvent` decorators.

### Remaining TODOs

- **SLA criteria engine**: plan selection beyond org-based lookup is TODO.
- **Attachment upload**: `Attachment` model exists; no upload endpoint or storage adapter.
- **IMAP IDLE**: replace polling with push-based IMAP IDLE.
- **Inbound raw-MIME externalisation**: ledger stores raw MIME inline; externalise very large
  messages to object storage (keep `rawStorageKey`). Inline blobs are meanwhile bounded by the
  hourly retention prune (`TELECOM_HD_INBOUND_RAW_RETENTION_DAYS`).
- **Public ticket rate-limiting**: `POST /tickets/public` — use `@nestjs/throttler`.
- **Frontend staff auth**: JWT-only; no cookie session.

## 5. Data model

See `apps/api/prisma/schema.prisma` and:

- ADR-0002: custom fields → JSONB
- ADR-0003: attachments storage strategy
