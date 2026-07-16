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

| Module                 | Location                      | Responsibility                                                                                                                                                                         |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PrismaModule`         | `src/prisma/`                 | Global DB access via PrismaService                                                                                                                                                     |
| `AuthModule`           | `src/auth/`                   | Login/refresh/logout, JWT issuance, RBAC guards (`JwtAuthGuard`, `PermissionsGuard`)                                                                                                   |
| `StaffModule`          | `src/modules/staff/`          | Staff members and staff groups; soft-delete (isEnabled=false)                                                                                                                          |
| `UsersModule`          | `src/modules/users/`          | End-user profiles; multi-email management (primary + extras)                                                                                                                           |
| `OrganizationsModule`  | `src/modules/organizations/`  | Client organizations; links to SLA plans                                                                                                                                               |
| `DepartmentsModule`    | `src/modules/departments/`    | Self-referential department tree; flat + nested views                                                                                                                                  |
| `TicketsModule`        | `src/modules/tickets/`        | Full ticket lifecycle: create, reply, note, assign, status/priority/type change, merge, watchers, tags, audit log; reference data (statuses, priorities, types)                        |
| `AlarisModule`         | `src/modules/alaris/`         | Alaris monitoring webhook → auto-ticket creation (shared-secret, deduplication)                                                                                                        |
| `SlaModule`            | `src/modules/sla/`            | SLA plans/schedules/holidays/escalation-rules CRUD + admin HTTP routes; working-hours due-date calc; breach detection; escalation action executor; BullMQ `sla` queue + `SlaProcessor` |
| `MailModule`           | `src/modules/mail/`           | Outbound (nodemailer SMTP + DB templates); inbound IMAP polling → ticket threading; BullMQ `mail` queue + `MailProcessor`                                                              |
| `NewsModule`           | `src/modules/news/`           | Staff-managed news items; public read, staff write                                                                                                                                     |
| `KnowledgebaseModule`  | `src/modules/knowledgebase/`  | Articles, categories, revision history; public read for published, staff write                                                                                                         |
| `ReportsModule`        | `src/modules/reports/`        | Dashboard metrics + stored reports (KQL-lite aggregation over tickets)                                                                                                                 |
| `TroubleshooterModule` | `src/modules/troubleshooter/` | Branching troubleshooting guides: categories → steps → step links                                                                                                                      |
| `WorkflowModule`       | `src/modules/workflow/`       | Workflow/Macro/MacroCategory CRUD + admin HTTP routes; `WorkflowExecutor` (EventEmitter2 listeners); `AutoCloseProcessor` (BullMQ `workflow` queue)                                    |
| `AdminModule`          | `src/modules/admin/`          | Custom field group/field CRUD + `validateCustomFields()` cross-module helper; email template CRUD                                                                                      |

All 16 modules above are registered in `AppModule` and serve live routes (verified responding).

## 3. Request lifecycle

```
HTTP Request
  → NestJS Router (global prefix: /api)
  → CsrfGuard  (rejects cookie-authenticated `th_access`/`th_client` unsafe methods whose Origin/
     Referer ≠ the configured app origin; Bearer-auth + cookieless requests pass — S3-5)
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

**Client (customer) auth mode (S2).** Distinct from staff JWT: a magic-link
(`request-link` → single-use hashed token → `verify`) opens a hashed `ClientSession`
behind an HttpOnly `th_client` cookie, bound to a stable `User.id`. Routes decorated
`@ClientAuthenticated()` (= `@Public()` + `ClientAuthGuard`) resolve `req.client = {userId}`;
client ticket routes (`/tickets/my`, `/tickets/public/:id`, `.../reply`) authorize strictly
by `Ticket.userId === client.userId`. Never reuses staff JWT/RBAC identity.

## 4. Background jobs _(auto)_

### Implemented — BullMQ queues

`BullModule.forRoot()` is registered in `AppModule` with Redis connection from `REDIS_URL`.

| Component            | Mechanism                                            | What it does                                                                                                                       |
| -------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `InboundMailService` | `setInterval` (60 s), `OnModuleInit`                 | Polls enabled IMAP queues; threads replies by `TT-XXXXXX` mask in subject; creates new tickets from unthreaded messages            |
| `SlaProcessor`       | BullMQ queue `sla`, repeatable `scan` job (60 s)     | Calls `SlaService.runPeriodicCheck()` → breach detection → escalation action execution (notify, priority change, assign, add note) |
| `AutoCloseProcessor` | BullMQ queue `workflow`, repeatable `auto-close` job | Closes pending tickets idle > `TELECOM_HD_AUTO_CLOSE_DAYS` days (default 7); sends `autoresponder` mail template                   |
| `MailProcessor`      | BullMQ queue `mail`, per-job                         | Async outbound mail delivery via `MailService`/nodemailer                                                                          |

### Implemented — EventEmitter2

`EventEmitterModule.forRoot()` is registered in `AppModule`. `TicketsService` emits typed events
(`ticket.created`, `ticket.replied`, `ticket.status_changed`) consumed by `WorkflowExecutor`
via `@OnEvent` decorators.

### Remaining TODOs

- **SLA criteria engine**: plan selection beyond org-based lookup is TODO.
- **Attachment upload**: `Attachment` model exists; no upload endpoint or storage adapter.
- **IMAP IDLE**: replace polling with push-based IMAP IDLE.
- **IMAP password decryption**: `EmailQueue.passwordEnc` stored but decryption not implemented.
- **Public ticket rate-limiting**: `POST /tickets/public` — use `@nestjs/throttler`.
- **Frontend staff auth**: JWT-only; no cookie session.

## 5. Data model

See `apps/api/prisma/schema.prisma` and:

- ADR-0002: custom fields → JSONB
- ADR-0003: attachments storage strategy
