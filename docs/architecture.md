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
  → JwtAuthGuard  (checks @Public(); if not public, verifies Bearer JWT, attaches AuthStaff to req.user)
  → PermissionsGuard  (checks @RequirePermissions(...); admins bypass all checks)
  → ZodValidationPipe  (validates + transforms body/query via Zod schema)
  → Controller method
  → Service (business logic + Prisma)
  → GlobalExceptionFilter  (normalizes errors to JSON { statusCode, message })
  → Pino HTTP logger  (structured JSON request logs)
```

Public routes (bypass JWT): `POST /auth/login`, `POST /auth/refresh`,
`POST /tickets/public`, `POST /alaris/webhook` (but checks shared-secret header),
`GET /news`, `GET /kb/articles`, `GET /kb/articles/slug/:slug`, `GET /kb/categories`.

## 4. Background jobs _(auto)_

### Implemented — BullMQ queues

`BullModule.forRoot()` is registered in `AppModule` with Redis connection from `REDIS_URL`.

| Component            | Mechanism                                              | What it does                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InboundMailService` | `setInterval` (60 s poll + 30 s drain), `OnModuleInit` | Durable, fail-closed inbound via the `InboundDelivery` ledger: accepts each IMAP/PIPE message (raw MIME) under a unique transport key, advances the `EmailQueue` UID cursor only on durable acceptance (monotonic CAS), then drains ACCEPTED/RETRY deliveries → thread/create ticket, with retry→quarantine (never discards). Sync bootstrap barrier at connect; fail-closed UIDVALIDITY halt |
| `SlaProcessor`       | BullMQ queue `sla`, repeatable `scan` job (60 s)       | Calls `SlaService.runPeriodicCheck()` → breach detection → escalation action execution (notify, priority change, assign, add note)                                                                                                                                                                                                                                                            |
| `AutoCloseProcessor` | BullMQ queue `workflow`, repeatable `auto-close` job   | Closes pending tickets idle > `TELECOM_HD_AUTO_CLOSE_DAYS` days (default 7); sends `autoresponder` mail template                                                                                                                                                                                                                                                                              |
| `MailProcessor`      | BullMQ queue `mail`, per-job                           | Async outbound mail delivery via `MailService`/nodemailer                                                                                                                                                                                                                                                                                                                                     |

### Implemented — EventEmitter2

`EventEmitterModule.forRoot()` is registered in `AppModule`. `TicketsService` emits typed events
(`ticket.created`, `ticket.replied`, `ticket.status_changed`) consumed by `WorkflowExecutor`
via `@OnEvent` decorators.

### Remaining TODOs

- **SLA criteria engine**: plan selection beyond org-based lookup is TODO.
- **Attachment upload**: `Attachment` model exists; no upload endpoint or storage adapter.
- **IMAP IDLE**: replace polling with push-based IMAP IDLE.
- **Inbound raw-MIME externalisation**: ledger stores raw MIME inline; externalise very large
  messages to object storage (keep `rawStorageKey`).
- **Inbound admin surface**: queue diagnostics (cursor, UIDVALIDITY, sync state) + ledger
  quarantine list and replay endpoint.
- **Public ticket rate-limiting**: `POST /tickets/public` — use `@nestjs/throttler`.
- **Frontend staff auth**: JWT-only; no cookie session.

## 5. Data model

See `apps/api/prisma/schema.prisma` and:

- ADR-0002: custom fields → JSONB
- ADR-0003: attachments storage strategy
