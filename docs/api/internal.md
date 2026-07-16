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

Constructor: `(prisma: PrismaService, usersService: UsersService, slaService: SlaService, eventEmitter: EventEmitter2)`

```ts
createTicket(dto: CreateTicketDto, creatorStaffId?: number): Promise<Ticket>
// Resolves/creates requester User by email, generates mask (TT-XXXXXX),
// creates first TicketPost, resolves default status/priority, writes CREATE audit log.
// SLA wiring (implemented): calls slaService.resolvePlanForTicket(orgId) to set slaPlanId,
// then slaService.computeDueDates(slaPlanId, now) to set dueAt + resolutionDueAt.
// Fires eventEmitter.emit('ticket.created', { ticketId }) on completion.
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

split(sourceTicketId: number, dto: SplitTicketDto, staffId: number): Promise<Ticket>
// Moves selected posts (dto.postIds) into a brand-new ticket (dto.subject / dto.departmentId?).
// Inherits requester, owner, priority, type, customFields, and slaPlanId from source.
// Recomputes SLA due dates for the new ticket. Decrements source.totalReplies.
// Writes SPLIT audit on both source and new ticket.
// Fires eventEmitter.emit('ticket.created', { ticketId: newTicket.id }).

addWatcher(ticketId: number, dto: WatcherDto): Promise<void>
removeWatcher(ticketId: number, staffId: number): Promise<void>
addTag(ticketId: number, dto: TagDto): Promise<void>
removeTag(ticketId: number, tagName: string): Promise<void>
```

**Domain events (implemented):** `protected emitDomainEvent(event: string, ticketId: number): void`
Uses `EventEmitter2.emit()` — no longer a stub. Events fired:

- `ticket.created` — on `createTicket()` and `split()` (for the new ticket)
- `ticket.replied` — on `reply()`
- `ticket.status_changed` — on `changeStatus()`

Consumed by `WorkflowExecutor` (`@OnEvent` listeners).

---

## SlaService (`apps/api/src/modules/sla/sla.service.ts`)

Constructor: `(prisma: PrismaService, mailService: MailService)`

No HTTP controller. Invoked from `TicketsService.createTicket()` and `TicketsService.split()` for SLA wiring; and periodically by `SlaProcessor` (BullMQ `sla` queue, `scan` repeatable job).

```ts
computeDueDates(slaPlanId: number, now: Date): Promise<DueDates>
// DueDates = { dueAt: Date | null, resolutionDueAt: Date | null }
// Applies SlaSchedule.workHours (minute-by-minute advance, max 60-day cap)
// and SlaHoliday entries. Falls back to wall-clock if no schedule is attached to the plan.

checkBreaches(): Promise<BreachEntry[]>
// BreachEntry = { ticket: Ticket, breachType: 'FIRST_RESPONSE' | 'RESOLUTION', minutesOverdue }
// Finds open, unmerged tickets past dueAt (no firstResponseAt) or resolutionDueAt.

runPeriodicCheck(): Promise<void>
// Calls checkBreaches(), marks breaching tickets isEscalated=true (escalationLevel++).
// Then calls executeEscalationRules() which fetches EscalationRule rows for the ticket's
// slaPlanId where thresholdSeconds ≤ minutesOverdue and isEnabled=true, then executes each
// action: notify (sends 'sla_breach_internal' mail template), change_priority, assign,
// add_note, mark_escalated.

resolvePlanForTicket(organizationId: number | null | undefined): Promise<number | null>
// Returns the SLA plan ID to assign to a new ticket.
// Checks org.slaPlanId first; falls back to the first enabled plan with no criteria.
// Full rule-engine criteria matching is TODO.

// ── CRUD methods (called via SlaController HTTP routes) ──
listPlans / getPlan / createPlan / updatePlan / deletePlan
listSchedules / getSchedule / createSchedule / updateSchedule / deleteSchedule
listHolidays / createHoliday / updateHoliday / deleteHoliday
listRules / createRule / updateRule / deleteRule
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

- On init: queries `EmailQueue` for enabled IMAP queues, decrypts `passwordEnc`, connects via
  `imapflow`, starts a 60-second `setInterval` poll.
- **UID cursor (IN-01).** Per queue we persist a watermark in `Setting`
  (`section='imap'`, `key='lastSeenUid:<queueId>'`) as `{ uid, uidValidity }`. `fetch()` is
  called as `fetch('<uid+1>:*', { envelope, source }, { uid: true })` — `{ uid: true }` **must**
  be the third argument so the range is a UID range, not a sequence range (sequence numbers drift
  from UIDs after `EXPUNGE`). Legacy bare-number watermarks are read and transparently upgraded to
  the object form on the next poll.
- **Bootstrap NOW / UIDVALIDITY (IN-02, IN-01).** On the first poll (no watermark) — or when the
  server's `UIDVALIDITY` differs from the stored one — the cursor is set to the current high-water
  UID and the existing mailbox is **not** imported. The high-water UID is `uidNext-1` when the
  server advertises `UIDNEXT`, else the highest existing UID from a `*` UID fetch (or `0` for an
  empty mailbox). If it cannot be determined, bootstrap is **deferred** to a later poll — it never
  fails open to `1:*` (which would re-import the whole mailbox). This prevents mass historical
  ticket creation and autoresponder storms on a fresh connect or a server-side UID reset.
- **Poison-message isolation + no silent loss (IN-03).** A message that throws is retried on
  subsequent polls up to `MAX_POISON_ATTEMPTS` (5); the watermark is **not** advanced past the
  lowest still-failing UID, so no message is skipped. Once attempts are exhausted the message is
  quarantined (logged) and the cursor advances so it can never wedge the queue. The echo/skip guard
  is gated on the **fixed** `lastUid` (not a moving cursor), and the watermark is capped at
  `min(highestProcessed, lowestFailingUid-1)`, so a message the server returns **out of UID order**
  below a higher one is never silently dropped. Attempt counts live in an in-memory `Map`; the
  durable `InboundDelivery` ledger is the target model for cross-restart retry/quarantine state.
- **Idempotency (IN-03).** Before ticketing, `processMessage` skips any message whose RFC
  `Message-ID` already exists on a `TicketPost`. The incoming `Message-ID` is written **atomically**
  with the created post — `TicketsService.reply()` / `createTicket()` accept an internal `messageId`
  and set it in the same `create` (not a follow-up `UPDATE`) — so a retry after a mid-processing
  failure, or a crash before the watermark write, is de-duplicated instead of double-posting.
  Messages with no `Message-ID` still rely on the UID watermark; fully-atomic cross-poller de-dup
  (a unique `Message-ID` claim) is deferred to the ledger work (IN-06).
- Per message: threads replies into existing tickets by RFC `In-Reply-To`/`References`
  (`TicketPost.messageId`), then by `TT-XXXXXX` mask in the subject line (calls
  `TicketsService.reply()`); creates new tickets for unthreaded messages. A mask that resolves to
  no ticket falls through to create-new **only** on `NotFoundException` (IN-10) — transient/DB
  errors are rethrown into the poll loop's retry/quarantine path instead of silently spawning a
  duplicate ticket.
- TODO: replace `setInterval` with IMAP IDLE push; durable `InboundDelivery` ledger; queue
  supervisor for reconnect/reconcile on disable/credential-change.

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

## WorkflowService (`apps/api/src/modules/workflow/workflow.service.ts`)

Consumed by: `WorkflowController`, `MacroCategoryController`, `MacroController`.

```ts
listWorkflows / getWorkflow / createWorkflow / updateWorkflow / deleteWorkflow
listMacroCategories / getMacroCategory / createMacroCategory / updateMacroCategory / deleteMacroCategory
listMacros(categoryId?: number) / getMacro / createMacro / updateMacro / deleteMacro
```

---

## WorkflowExecutor (`apps/api/src/modules/workflow/workflow.executor.ts`)

Listens for `EventEmitter2` domain events fired by `TicketsService` and evaluates all enabled
workflows against the mutated ticket.

```ts
@OnEvent('ticket.created') → evaluate(ticketId, 'ticket.created')
@OnEvent('ticket.replied') → evaluate(ticketId, 'ticket.replied')
@OnEvent('ticket.status_changed') → evaluate(ticketId, 'ticket.status_changed')
```

`evaluate()` loads all enabled `Workflow` rows (ordered by `sortOrder`), runs `matchesCriteria()`
against the ticket, and calls `applyActions()` for each matching workflow.

**Criteria operators:** `eq | neq | contains | gt | lt` on any scalar ticket field.

**Action types:** `change_department | change_owner | change_status | change_priority | change_type | add_tag | add_note`

---

## AdminService (`apps/api/src/modules/admin/admin.service.ts`)

Consumed by: `AdminController`.

```ts
// ── Custom field groups ──
listGroups(): Promise<CustomFieldGroup[]>       // includes fields ordered by displayOrder
createGroup(dto): Promise<CustomFieldGroup>
updateGroup(id, dto): Promise<CustomFieldGroup>
deleteGroup(id): Promise<void>

// ── Custom fields ──
createField(groupId, dto): Promise<CustomField>
updateField(id, dto): Promise<CustomField>      // fieldKey is immutable (omitted from update schema)
deleteField(id): Promise<void>

/**
 * Cross-module validation helper — called by any entity that stores customFields JSONB.
 * Loads field definitions for the given scope, then enforces:
 *   - isRequired fields must be present and non-null/empty
 *   - Values must match the field's type (TEXT→string, CHECKBOX→boolean, MULTISELECT→array, DATE→ISO string, etc.)
 * Throws BadRequestException on first violation.
 */
validateCustomFields(scope: CustomFieldScope, values: Record<string, unknown>): Promise<void>

// ── Email templates ──
listTemplates(): Promise<EmailTemplate[]>        // ordered by key, locale
createTemplate(dto): Promise<EmailTemplate>
updateTemplate(id, dto): Promise<EmailTemplate>  // key and locale are immutable
deleteTemplate(id): Promise<void>
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

`BullModule.forRoot()` is registered in `AppModule` with the Redis connection from `REDIS_URL`.
Each feature module that needs a queue calls `BullModule.registerQueue({ name })`.

| Queue      | Job                       | Producer                 | Consumer             | Purpose                                                                                                             |
| ---------- | ------------------------- | ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `sla`      | `scan` (repeatable, 60 s) | `SlaModule` on init      | `SlaProcessor`       | Periodic SLA breach scan → `SlaService.runPeriodicCheck()`                                                          |
| `workflow` | `auto-close` (repeatable) | `WorkflowModule` on init | `AutoCloseProcessor` | Close idle pending tickets after `TELECOM_HD_AUTO_CLOSE_DAYS` days (default 7); sends `autoresponder` mail template |
| `mail`     | per-message send job      | `MailService`            | `MailProcessor`      | Async outbound mail delivery via nodemailer                                                                         |

`InboundMailService` still uses `setInterval` (60 s) for IMAP polling; IMAP IDLE is a future TODO.

---

## Domain events

`TicketsService.emitDomainEvent()` calls `EventEmitter2.emit()` (fully implemented — not a stub).

Events fired:

| Event                   | Fired by                                 | Consumed by                                |
| ----------------------- | ---------------------------------------- | ------------------------------------------ |
| `ticket.created`        | `createTicket()`, `split()` (new ticket) | `WorkflowExecutor.onTicketCreated()`       |
| `ticket.replied`        | `reply()`                                | `WorkflowExecutor.onTicketReplied()`       |
| `ticket.status_changed` | `changeStatus()`                         | `WorkflowExecutor.onTicketStatusChanged()` |

`EventEmitterModule.forRoot()` is registered in `AppModule`.
