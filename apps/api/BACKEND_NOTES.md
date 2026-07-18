# 23 Telecom Help Desk — Backend Notes

## What was created

### Auth (`apps/api/src/auth/`)

| File                               | Purpose                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jwt-auth.guard.ts`                | Global guard: verifies the environment-selected HttpOnly access cookie (or explicit external/test Bearer), then reloads enabled Staff + group and checks `authVersion` before attaching `AuthStaff` |
| `permissions.guard.ts`             | `PermissionsGuard` + exports `PERMISSIONS_KEY`; admins pass all checks                                                                                                                              |
| `auth.service.ts`                  | Login, jti/family refresh rotation, authoritative logout-all, and `authVersion`-stamped atomic password reset; argon2id hashes stored for refresh tokens                                            |
| `auth.controller.ts`               | Cookie-only `POST /auth/login`, `/refresh`, `/logout`; `GET /auth/me`, `/csrf`; browser JSON never contains JWTs                                                                                    |
| `auth.module.ts`                   | Registers `JwtModule.register(...)` with access secret from `loadConfig()`                                                                                                                          |
| `auth.cookies.ts`                  | Production/dev cookie names, exact paths, safe parsing, and current/legacy clearing                                                                                                                 |
| `csrf.guard.ts`, `csrf.service.ts` | Exact-origin and signed double-submit CSRF for cookie-authenticated mutations                                                                                                                       |
| `dto.ts`                           | Login and password-reset Zod schemas; refresh has no body-token DTO                                                                                                                                 |
| `password.util.ts`                 | `hashPassword` / `verifyPassword` (argon2id)                                                                                                                                                        |

### Base Modules (`apps/api/src/modules/`)

| Module           | Routes                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| `staff/`         | `/staff/groups` CRUD, `/staff` CRUD (soft-disable); strips `passwordHash` |
| `users/`         | `/users` CRUD + multi-email management (`/users/:id/emails`)              |
| `organizations/` | `/organizations` CRUD                                                     |
| `departments/`   | `/departments` flat list + `/departments/tree`; CRUD with parent/children |

### Tickets (`apps/api/src/modules/tickets/`)

| File                      | Purpose                                                                                                                                                                                                                                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tickets.service.ts`      | Full lifecycle: create (mask generation, user resolve/create, first post, audit), listTickets (filters + pagination), getTicket (deep include), reply, addNote, assign, changeStatus/Priority/Type, merge (post re-parent + audit both sides), addWatcher/removeWatcher, addTag/removeTag; `emitDomainEvent` stub |
| `tickets.controller.ts`   | REST under `/tickets`; `POST /tickets/public` (Public); all other routes guarded with `TICKET_*` permissions                                                                                                                                                                                                      |
| `ticket-mask.util.ts`     | `formatTicketMask(id)` → `TT-XXXXXX`                                                                                                                                                                                                                                                                              |
| `reference.service.ts`    | CRUD for `TicketStatus`, `TicketPriority`, `TicketType`                                                                                                                                                                                                                                                           |
| `reference.controller.ts` | `GET/POST/PATCH/DELETE /ticket-statuses`, `/ticket-priorities`, `/ticket-types`                                                                                                                                                                                                                                   |
| `dto.ts`                  | All Zod schemas: CreateTicket, Reply, Assign, ChangeStatus/Priority/Type, Merge, Tag, Watcher, ListQuery, PublicCreate                                                                                                                                                                                            |

### Alaris (`apps/api/src/modules/alaris/`)

- `POST /alaris/webhook` — shared-secret header (`x-alaris-secret`), dedupes by `externalId`, creates ticket via `TicketsService`, links `AlarisEvent.ticketId`; returns `{ event, ticket, deduplicated }`.

### SLA (`apps/api/src/modules/sla/`)

- `computeDueDates(slaPlanId, now)` — real working-hours calculator (minute-by-minute advance, honours SlaSchedule.workHours and holidays); falls back to wall-clock when no schedule
- `checkBreaches()` — finds tickets past `dueAt`/`resolutionDueAt`, returns `BreachEntry[]`
- `runPeriodicCheck()` — marks tickets as escalated; plugs into BullMQ or @nestjs/schedule cron (TODO)
- `resolvePlanForTicket(organizationId)` — org-based SLA plan selection

### Mail (`apps/api/src/modules/mail/`)

- `MailService`: outbound via nodemailer SMTP; `renderTemplate(key, locale, vars)` with `{{key}}` substitution and en fallback
- `InboundMailService`: bounded IMAP/PIPE ingestion; per-UID durable checkpoint + poison-message
  quarantine; sender-authorized RFC/mask threading; bounded MIME parser concurrency and safe-subset
  parser-rule regex; `pollHandle` cleaned up on destroy

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
2. **Global auth backstop**: `JwtAuthGuard` protects every route unless it is explicitly `@Public()`; `PermissionsGuard` then enforces any `@RequirePermissions(...)` metadata. `CsrfGuard` independently protects cookie-authenticated unsafe methods.
3. **Ticket mask**: created as `TT-PENDING` then updated immediately after insert — the only safe pattern without a DB sequence that formats with `TT-` prefix.
4. **Refresh token rotation**: raw tokens are argon2-hashed; the JWT `jti` performs a direct indexed row lookup, a conditional consume elects one winner, and replay revokes the token family. Browser refresh reads only the narrow-path HttpOnly cookie.
5. **SLA working-hours calculator**: minute-granularity loop (≤60-day safety cap). Accurate for typical SLA windows; replace with calendar-interval algorithm for very long SLA periods.
6. **IMAP polling**: 60-second `setInterval`, non-overlapping INBOX scan, UIDVALIDITY-bound
   per-message checkpoints, and a three-attempt `Helpdesk-Processing-Errors` dead-letter mailbox. A UIDVALIDITY
   change pauses the affected queue for deliberate operator inspection/reset. IMAP IDLE push is a TODO.

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
