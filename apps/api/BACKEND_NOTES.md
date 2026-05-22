# 23 Telecom Help Desk — Backend Notes

## What was created

### Auth (`apps/api/src/auth/`)
| File | Purpose |
|---|---|
| `jwt-auth.guard.ts` | `JwtAuthGuard implements CanActivate` — reads `IS_PUBLIC_KEY` via Reflector, verifies Bearer token with `@nestjs/jwt`, attaches `AuthStaff` to `req.user` |
| `permissions.guard.ts` | `PermissionsGuard` + exports `PERMISSIONS_KEY`; admins pass all checks |
| `auth.service.ts` | `validateStaff`, `login`, `refresh` (rotation), `logout` (revoke all), `buildPrincipal`; argon2id hashes stored for refresh tokens |
| `auth.controller.ts` | `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me` |
| `auth.module.ts` | Registers `JwtModule.register(...)` with access secret from `loadConfig()` |
| `dto.ts` | `LoginSchema`, `RefreshSchema` (Zod) |
| `password.util.ts` | `hashPassword` / `verifyPassword` (argon2id) |

### Base Modules (`apps/api/src/modules/`)
| Module | Routes |
|---|---|
| `staff/` | `/staff/groups` CRUD, `/staff` CRUD (soft-disable); strips `passwordHash` |
| `users/` | `/users` CRUD + multi-email management (`/users/:id/emails`) |
| `organizations/` | `/organizations` CRUD |
| `departments/` | `/departments` flat list + `/departments/tree`; CRUD with parent/children |

### Tickets (`apps/api/src/modules/tickets/`)
| File | Purpose |
|---|---|
| `tickets.service.ts` | Full lifecycle: create (mask generation, user resolve/create, first post, audit), listTickets (filters + pagination), getTicket (deep include), reply, addNote, assign, changeStatus/Priority/Type, merge (post re-parent + audit both sides), addWatcher/removeWatcher, addTag/removeTag; `emitDomainEvent` stub |
| `tickets.controller.ts` | REST under `/tickets`; `POST /tickets/public` (Public); all other routes guarded with `TICKET_*` permissions |
| `ticket-mask.util.ts` | `formatTicketMask(id)` → `TT-XXXXXX` |
| `reference.service.ts` | CRUD for `TicketStatus`, `TicketPriority`, `TicketType` |
| `reference.controller.ts` | `GET/POST/PATCH/DELETE /ticket-statuses`, `/ticket-priorities`, `/ticket-types` |
| `dto.ts` | All Zod schemas: CreateTicket, Reply, Assign, ChangeStatus/Priority/Type, Merge, Tag, Watcher, ListQuery, PublicCreate |

### Alaris (`apps/api/src/modules/alaris/`)
- `POST /alaris/webhook` — shared-secret header (`x-alaris-secret`), dedupes by `externalId`, creates ticket via `TicketsService`, links `AlarisEvent.ticketId`; returns `{ event, ticket, deduplicated }`.

### SLA (`apps/api/src/modules/sla/`)
- `computeDueDates(slaPlanId, now)` — real working-hours calculator (minute-by-minute advance, honours SlaSchedule.workHours and holidays); falls back to wall-clock when no schedule
- `checkBreaches()` — finds tickets past `dueAt`/`resolutionDueAt`, returns `BreachEntry[]`
- `runPeriodicCheck()` — marks tickets as escalated; plugs into BullMQ or @nestjs/schedule cron (TODO)
- `resolvePlanForTicket(organizationId)` — org-based SLA plan selection

### Mail (`apps/api/src/modules/mail/`)
- `MailService`: outbound via nodemailer SMTP; `renderTemplate(key, locale, vars)` with `{{key}}` substitution and en fallback
- `InboundMailService`: IMAP polling (imapflow) on module init; threads replies by ticket mask in subject; creates new tickets otherwise; `pollHandle` cleaned up on destroy

### App wiring
- `app.module.ts`: `LoggerModule` (nestjs-pino), `PrismaModule` (global), all feature modules; `APP_CONFIG` provided as `{ provide: APP_CONFIG, useValue: loadConfig() }` symbol token
- `main.ts`: `setGlobalPrefix('api')`, CORS from `TELECOM_HD_PUBLIC_URL`, Swagger at `/api/docs`, Pino logger, listens on `TELECOM_HD_API_PORT`

### Seed (`src/seed/seed.ts`)
- Idempotent via `findFirst`-or-create pattern (no ID-based upsert for autoincrement tables)
- Seeds: 2 StaffGroups, 2 Staff (admin/agent @ `demo1234`), 2 Departments, 5 Statuses, 4 Priorities, 4 Types, 1 SLA plan + Mon–Fri schedule, 5 EmailTemplates (en+ru), 2 Orgs, 4 Users, 5 demo tickets with posts

### Tests
- `vitest.config.ts` — unit, v8 coverage, `src/**/*.spec.ts`
- `vitest.integration.config.ts` — integration, `src/**/*.int-spec.ts`, 120 s timeout
- `auth.service.spec.ts` — validateStaff (found/disabled/wrong pw), login (token pair), logout (revoke), buildPrincipal
- `tickets.service.spec.ts` — mask util, createTicket (happy path + no-default-status), assign, changeStatus (resolves + 404), merge (self/already-merged/happy path)
- `sla.service.spec.ts` — computeDueDates (not found, wall-clock, working hours, null firstResponseSeconds), checkBreaches (empty, FR breach, resolution breach, double breach)
- `tickets.int-spec.ts` — Testcontainers Postgres, prisma migrate deploy, seed, create + get + reply + list + status change + public submit

---

## Key design decisions

1. **AppConfig injection**: `APP_CONFIG = Symbol('APP_CONFIG')` value token, resolved from `loadConfig()` at module load time. Each module that needs it provides it locally (avoids circular dependency with AppModule).
2. **No global JwtAuthGuard**: guards are applied per-route via `@RequirePermissions(...)` and `@Public()` decorators. Public routes (login, refresh, alaris webhook, public ticket submit) are not JWT-gated.
3. **Ticket mask**: created as `TT-PENDING` then updated immediately after insert — the only safe pattern without a DB sequence that formats with `TT-` prefix.
4. **Refresh token rotation**: raw token is argon2-hashed before storage; on refresh, all active tokens for the staff member are scanned (typically ≤2) to find the matching hash.
5. **SLA working-hours calculator**: minute-granularity loop (≤60-day safety cap). Accurate for typical SLA windows; replace with calendar-interval algorithm for very long SLA periods.
6. **IMAP polling**: 60-second `setInterval`, single INBOX scan per cycle. IMAP IDLE push is a TODO.

---

## TODOs / What still needs work

### To run:
1. `npm install` inside `apps/api/`
2. `npx prisma generate` (generates PrismaClient types)
3. `npx prisma migrate deploy` (applies migrations to the DB)
4. Set all `TELECOM_HD_*` env vars (see `.env.example`)
5. `npm run seed` to populate reference data

### Feature TODOs:
- **BullMQ SLA queue**: add `@nestjs/bullmq`, register queue `'sla'`, create `SlaProcessor` with `@Processor('sla')` that calls `slaService.runPeriodicCheck()` on a cron schedule
- **Ticket domain events**: replace `emitDomainEvent()` stub with real EventEmitter2 / BullMQ jobs for workflow automation
- **IMAP IDLE**: replace `setInterval` polling with IMAP IDLE push (imapflow supports it)
- **IMAP password decryption**: `EmailQueue.passwordEnc` is stored but decryption is not implemented
- **Public ticket rate limiting**: `POST /tickets/public` has a TODO comment; use `@nestjs/throttler`
- **Full EscalationRule.actions executor**: currently only marks `isEscalated=true`; needs to parse `actions` JSON and apply (notify, change priority, etc.)
- **SLA plan criteria engine**: `SlaPlan.criteria` is JSON but only org-based plan selection is implemented; full rule engine is a TODO
- **Attachment upload**: `Attachment` model exists but no upload endpoint; needs a storage adapter (S3/disk)
- **WorkflowEngine**: `Workflow` and `MacroCategory`/`Macro` models are in the schema but have no service yet
- **KnowledgeBase + News endpoints**: schema models exist, no controllers
- **Staff portal auth (frontend)**: no cookie-based session; current auth is JWT-only
