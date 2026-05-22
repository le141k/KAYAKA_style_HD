# Architecture — 23 Telecom Help Desk

> Living doc — keep current (see `CLAUDE.md` → "Living docs"). Sections marked _(auto)_ are
> regenerated from code by the docs-keeper agent; prose sections are maintained by hand.

## 1. Overview

Modular monolith. A NestJS API exposes a REST surface (Swagger at `/api/docs`) backed by
PostgreSQL (Prisma) and Redis (BullMQ — planned; not yet wired). A Next.js App Router frontend
renders three audiences (client / staff / admin) against that API.

```
                ┌────────────┐      REST/JSON      ┌──────────────────────┐
   Browser ───▶ │  Next.js   │ ──────────────────▶ │   NestJS API (4000)  │
  (3 UIs)       │  web (3000)│ ◀────────────────── │  /api, /api/docs     │
                └────────────┘                     └─────────┬────────────┘
                                                             │ Prisma
   Inbound mail (IMAP) ─▶ InboundMailService ─▶ tickets       ▼
   Outbound mail ◀─ nodemailer ◀─ MailService  ┌──────────────┐  ┌─────────────┐
   Alaris webhook ─▶ AlarisService ─▶ tickets  │ PostgreSQL 16│  │ Redis       │
                                               └──────────────┘  │ (BullMQ —  │
                                                                  │  planned)  │
                                                                  └─────────────┘
```

## 2. Modules _(auto — read from apps/api/src/app.module.ts)_

The following modules are registered in `AppModule` (the authoritative list):

| Module | Location | Responsibility |
|---|---|---|
| `PrismaModule` | `src/prisma/` | Global DB access via PrismaService |
| `AuthModule` | `src/auth/` | Login/refresh/logout, JWT issuance, RBAC guards (`JwtAuthGuard`, `PermissionsGuard`) |
| `StaffModule` | `src/modules/staff/` | Staff members and staff groups; soft-delete (isEnabled=false) |
| `UsersModule` | `src/modules/users/` | End-user profiles; multi-email management (primary + extras) |
| `OrganizationsModule` | `src/modules/organizations/` | Client organizations; links to SLA plans |
| `DepartmentsModule` | `src/modules/departments/` | Self-referential department tree; flat + nested views |
| `TicketsModule` | `src/modules/tickets/` | Full ticket lifecycle: create, reply, note, assign, status/priority/type change, merge, watchers, tags, audit log; reference data (statuses, priorities, types) |
| `AlarisModule` | `src/modules/alaris/` | Alaris monitoring webhook → auto-ticket creation (shared-secret, deduplication) |
| `SlaModule` | `src/modules/sla/` | SLA plans, working-hours due-date calculation, breach detection, escalation marker |
| `MailModule` | `src/modules/mail/` | Outbound (nodemailer SMTP + DB templates); inbound IMAP polling → ticket threading |
| `NewsModule` | `src/modules/news/` | Staff-managed news items; public read, staff write |
| `KnowledgebaseModule` | `src/modules/knowledgebase/` | Articles, categories, revision history; public read for published, staff write |

| `ReportsModule` | `src/modules/reports/` | Dashboard metrics + stored reports (KQL-lite aggregation over tickets) |
| `TroubleshooterModule` | `src/modules/troubleshooter/` | Branching troubleshooting guides: categories → steps → step links |

All 14 modules above are registered in `AppModule` and serve live routes (verified responding).

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

### Currently implemented (no BullMQ — inline/lifecycle)

| Component | Mechanism | What it does |
|---|---|---|
| `InboundMailService` | `setInterval` (60 s), `OnModuleInit` | Polls enabled IMAP queues; threads replies by `TT-XXXXXX` mask in subject; creates new tickets from unthreaded messages |
| `SlaService.runPeriodicCheck()` | Not yet scheduled | Finds SLA breaches, marks tickets `isEscalated=true`; must be called from a cron or BullMQ processor |

### Planned (BullMQ — TODO)

`@nestjs/bullmq` is **not yet installed**. The `app.module.ts` comment describes the intended
wiring:

```
BullModule.forRoot({ connection: parseRedisUrl(config.REDIS_URL) })
```

Planned queues once wired:

| Queue | Job | Purpose |
|---|---|---|
| `sla` | `scan` | Trigger `SlaService.runPeriodicCheck()` on a cron; replace current no-schedule stub |
| `mail` (future) | IMAP poll | Optional: replace `setInterval` with BullMQ + IMAP IDLE push |

Additional TODOs (from `apps/api/BACKEND_NOTES.md`):
- **`EscalationRule.actions` executor**: `runPeriodicCheck()` marks `isEscalated=true` only; parsing and applying escalation actions (notify assignee, change priority) is not yet implemented.
- **SLA criteria engine**: plan selection beyond org-based lookup is TODO.
- **`TicketsService.emitDomainEvent()` stub**: replace with real EventEmitter2 / BullMQ for SLA recompute and workflow triggers.
- **WorkflowEngine**: `Workflow`, `MacroCategory`, `Macro` models in schema but no service.
- **Attachment upload**: `Attachment` model exists; no upload endpoint or storage adapter.
- **IMAP IDLE**: replace polling with push-based IMAP IDLE.
- **IMAP password decryption**: `EmailQueue.passwordEnc` stored but decryption not implemented.
- **Public ticket rate-limiting**: `POST /tickets/public` has a TODO; use `@nestjs/throttler`.
- **Frontend staff auth**: JWT-only; no cookie session.

## 5. Data model

See `apps/api/prisma/schema.prisma` and:
- ADR-0002: custom fields → JSONB
- ADR-0003: attachments storage strategy
