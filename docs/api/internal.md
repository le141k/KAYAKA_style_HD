# Internal API & service contracts — 23 Telecom Help Desk

> Living doc — describes the internal seams other modules depend on (service methods, domain
> events, queue jobs, invariants). Update when you change a cross-module contract
> (see `CLAUDE.md` → "Living docs"). _(Service signatures are read directly from source.)_

## Conventions

- Services are the unit of reuse; controllers are thin. Cross-module calls go through an
  injected service, never via HTTP.
- Mutations that change a ticket write a `TicketAuditLog` row.
- All timestamps are `DateTime` (UTC). SLA durations are in seconds (int).

---

## AuthService (`apps/api/src/auth/auth.service.ts`)

Consumed by: `AuthController`, `JwtAuthGuard`.

```ts
login(email: string, password: string): Promise<LoginResult>
// LoginResult = { accessToken, refreshToken, staff: AuthStaff }
// Validates credentials, issues JWT pair, persists argon2-hashed refresh token, updates lastLoginAt.

refresh(rawRefreshToken: string): Promise<TokenPair>
// Verifies token, revokes used token (rotation), issues fresh pair.

logout(staffId: number): Promise<void>
// Revokes all non-revoked refresh tokens for the staff member.

validateStaff(email: string, password: string): Promise<StaffWithGroup>
// Returns Staff+Group or throws UnauthorizedException.

buildPrincipal(staff: StaffWithGroup): AuthStaff
// AuthStaff = { staffId, email, isAdmin, permissions: Permission[] }
```

---

## TicketsService (`apps/api/src/modules/tickets/tickets.service.ts`)

Consumed by: `TicketsController`, `AlarisService`, `InboundMailService`.

```ts
createTicket(dto: CreateTicketDto, creatorStaffId?: number): Promise<Ticket>
// Resolves/creates requester User by email, generates mask (TT-XXXXXX),
// creates first TicketPost, resolves default status/priority, writes CREATE audit log.
// Invariant: every ticket has ≥1 post and a unique mask.

listTickets(query: ListTicketsQueryDto): Promise<{ data: Ticket[]; total: number }>
// Filters: statusId, priorityId, departmentId, typeId, userId, ownerStaffId,
// unassigned, search (subject/mask/email/name). Excludes merged-away tickets.

getTicket(id: number): Promise<TicketDetail>
// Includes: posts (with attachments), notes, watchers, tags, auditLogs (last 50).

getTicketByMask(mask: string): Promise<TicketDetail>
// Same as getTicket but looks up by human-readable mask, e.g. "TT-000042".

reply(ticketId: number, dto: ReplyTicketDto, staffId?: number): Promise<TicketPost | TicketNote>
// Appends post, bumps totalReplies + lastReplyAt + lastActivityAt;
// sets firstResponseAt on first staff reply. If dto.isNote is true, delegates to addNote().

addNote(ticketId: number, contents: string, staffId?: number): Promise<TicketNote>
// Internal-only note; sets ticket.hasNotes = true.

assign(ticketId: number, dto: AssignTicketDto, staffId: number): Promise<Ticket>
changePriority(ticketId: number, dto: ChangePriorityDto, staffId: number): Promise<Ticket>
changeStatus(ticketId: number, dto: ChangeStatusDto, staffId: number): Promise<Ticket>
// changeStatus also sets isResolved / resolvedAt based on TicketStatus.markAsResolved.
changeType(ticketId: number, dto: ChangeTypeDto, staffId: number): Promise<Ticket>

merge(sourceTicketId: number, dto: MergeTicketDto, staffId: number): Promise<Ticket>
// Moves all posts from source → target in a DB transaction;
// sets source.mergedIntoId, increments target.totalReplies.
// Writes MERGE audit on both source and target.

addWatcher(ticketId: number, dto: WatcherDto): Promise<void>
removeWatcher(ticketId: number, staffId: number): Promise<void>
addTag(ticketId: number, dto: TagDto): Promise<void>
removeTag(ticketId: number, tagName: string): Promise<void>
```

**Domain event hook (stub):** `protected emitDomainEvent(_event: string, _ticketId: number): void`
Currently a no-op. TODO: replace with `EventEmitter2` or BullMQ job dispatch to wire SLA and
workflow evaluation on ticket mutations.

---

## SlaService (`apps/api/src/modules/sla/sla.service.ts`)

No HTTP controller. Called by `runPeriodicCheck()` (currently must be wired manually or via cron;
BullMQ processor not yet registered).

```ts
computeDueDates(slaPlanId: number, now: Date): Promise<DueDates>
// DueDates = { dueAt: Date | null, resolutionDueAt: Date | null }
// Applies SlaSchedule.workHours (minute-by-minute advance, max 60-day cap)
// and SlaHoliday entries. Falls back to wall-clock if no schedule is attached to the plan.

checkBreaches(): Promise<BreachEntry[]>
// BreachEntry = { ticket: Ticket, breachType: 'FIRST_RESPONSE' | 'RESOLUTION', minutesOverdue }
// Finds open, unmerged tickets past dueAt (no firstResponseAt) or resolutionDueAt.

runPeriodicCheck(): Promise<void>
// Calls checkBreaches(), marks breaching tickets as isEscalated=true (increments escalationLevel).
// TODO: parse and execute EscalationRule.actions (notify staff, change priority, etc.).

resolvePlanForTicket(organizationId: number | null | undefined): Promise<number | null>
// Returns the SLA plan ID to assign to a new ticket.
// Checks org.slaPlanId first; falls back to the first enabled plan with no criteria.
// Full rule-engine criteria matching is TODO.
```

---

## MailService (`apps/api/src/modules/mail/mail.service.ts`)

```ts
send(opts: SendMailOptions): Promise<void>
// SendMailOptions = { to, subject, html?, text?, from? }
// Sends via nodemailer SMTP. Swallows errors (logs warning) to avoid crashing ticket flow.

renderTemplate(key: string, locale: string, vars: Record<string, string>): Promise<RenderedTemplate>
// RenderedTemplate = { subject, html, text }
// Loads EmailTemplate from DB by (key, locale); falls back to 'en'. Replaces {{key}} tokens.

sendTemplate(to: string | string[], templateKey: string, locale: string, vars: Record<string, string>): Promise<void>
// Convenience: renderTemplate() + send().
```

---

## InboundMailService (`apps/api/src/modules/mail/inbound.service.ts`)

Implements `OnModuleInit` / `OnModuleDestroy`. No public methods — driven entirely by lifecycle hooks.

- On init: queries `EmailQueue` for enabled IMAP queues, connects via `imapflow`, starts a
  60-second `setInterval` poll.
- Per message: threads replies into existing tickets by matching `TT-XXXXXX` mask in the subject
  line (calls `TicketsService.reply()`); creates new tickets for unthreaded messages.
- TODO: replace `setInterval` with IMAP IDLE push; implement `passwordEnc` decryption for stored
  IMAP credentials.

---

## AlarisService (`apps/api/src/modules/alaris/alaris.service.ts`)

```ts
ingest(payload: AlarisWebhookPayload): Promise<AlarisIngestResult>
// AlarisWebhookPayload = { externalId, severity, message, ...extras }
// AlarisIngestResult = { event: AlarisEvent, ticket: Ticket, deduplicated: boolean }
// Deduplicates by externalId (returns existing event if already processed).
// Creates ticket via TicketsService.createTicket() with creationMode='ALARIS',
// subject='[ALARIS-AUTO] <message>' (truncated to 500 chars).
// Stores AlarisEvent record linked to the ticket.
```

---

## ReportsService (`apps/api/src/modules/reports/reports.module.ts`)

> Registered in `app.module.ts`; live HTTP routes (see endpoints.md). Verified responding (200).

```ts
list(): Promise<Report[]>
create(dto: { title, kind, definition }): Promise<Report>
run(id: number): Promise<AggregatedRows>   // executes stored report definition
execute(def: Definition): Promise<AggregatedRows>  // ad-hoc execution
dashboard(): Promise<{ total, resolved, byStatus, byPriority }>
```

Definition schema supports: `source: 'tickets'`, `groupBy?: statusId|priorityId|departmentId|typeId|ownerStaffId|creationMode`, `filters`, `metric: 'count'`.

---

## TroubleshooterService (`apps/api/src/modules/troubleshooter/troubleshooter.module.ts`)

> Registered in `app.module.ts`; live HTTP routes (see endpoints.md). Verified responding (200).

```ts
categories(): Promise<TroubleshooterCategory[]>
tree(categoryId: number): Promise<TroubleshooterStep[]>  // steps with linksFrom
createCategory(data): Promise<TroubleshooterCategory>
createStep(data): Promise<TroubleshooterStep>
linkSteps(data: { fromId, toId, label }): Promise<TroubleshooterStepLink>
```

---

## NewsService (`apps/api/src/modules/news/news.module.ts`)

Inlined in the `NewsModule` file (no separate service file). Consumed by `NewsController`.

```ts
listPublished(): Promise<NewsItem[]>          // isPublished=true, ordered by publishedAt desc
listAll(): Promise<NewsItem[]>                // all items, ordered by createdAt desc
create(dto: NewsDto, authorStaffId?: number): Promise<NewsItem>
update(id: number, dto: Partial<NewsDto>): Promise<NewsItem>
```

---

## Queue jobs (BullMQ)

BullMQ is **not yet installed or configured** (`@nestjs/bullmq` is a TODO).
The `app.module.ts` comment notes: _"add BullModule.forRoot(...) once @nestjs/bullmq is installed
and the SLA queue processor is wired."_

Planned queues once wired:

| Queue | Job | Producer | Consumer | Purpose |
|---|---|---|---|---|
| `sla` | `scan` | scheduler / cron | `SlaProcessor` (TODO) | Periodic breach scan → escalation |
| `mail` | _(future)_ | — | — | Potential alternative to setInterval IMAP polling |

Currently `SlaService.runPeriodicCheck()` and `InboundMailService` run inline (lifecycle hooks /
setInterval). No BullMQ worker processes exist yet.

---

## Domain events

`TicketsService.emitDomainEvent()` is a **stub** (no-op). When implemented it should emit events
such as `ticket.created`, `ticket.replied`, `ticket.status_changed` for consumption by:
- `SlaService` — recompute due dates on ticket creation/change
- Future `WorkflowEngine` — evaluate macro/auto-action criteria

The `Workflow`, `MacroCategory`, and `Macro` Prisma models exist in the schema but have no
service implementation yet.
