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
login(email: string, password: string, ip?: string): Promise<LoginResult>
// LoginResult = { accessToken, refreshToken, staff: AuthStaff }
// Validates credentials, issues JWT pair, persists argon2-hashed refresh token, updates lastLoginAt.
// S3-7: before validating, asserts the caller is under the login-abuse throttle (LoginThrottleService,
// keyed by trusted client IP + HMAC(email)); records a failure on bad credentials and clears the
// counter on success. Over the threshold it throws a generic 429 (never an account-lock). Fail-open:
// a Redis outage does not block logins. Both the throttle 429 and the credential failure are generic
// so nothing about account existence or lock state is disclosed.

refresh(rawRefreshToken: string): Promise<TokenPair>
// S3-3: looks up EXACTLY ONE row by the token's opaque `jti` (no Argon2 scan), verifies
// its hash, and rotates via a conditional CAS (updateMany where jti + revokedAt null →
// count 1). Exactly one concurrent caller wins; a concurrent loser fails without revoking
// the family; a genuine later replay (already-rotated token presented after the grace
// window) revokes the whole `familyId`. New pair is issued in the same family.
// Race fix: each row is stamped with its issue-time authVersion; before the CAS, refresh
// loads the staff and rejects (quietly) if row.authVersion !== staff.authVersion — so a
// concurrent rotation cannot outrun logout-all / password / permission changes.

logout(staffId: number): Promise<void>
// Authoritative logout-ALL (S3-4): increments Staff.authVersion AND revokes every
// active refresh token in one transaction, so all outstanding access tokens fail the
// JWT guard's `av` check on their next request. Redis jti blocklist kept as defense-
// in-depth only.

revokeStaffSessions(staffId: number): Promise<void>
// Shared invalidation (S3-2): increments authVersion + revokes active refresh tokens
// atomically. Called by logout, password reset, and operator staff changes.

validateStaff(email: string, password: string): Promise<StaffWithGroup>
// Returns Staff+Group or throws UnauthorizedException.
// Anti-enumeration (S3-7): a missing/disabled account runs a decoy argon2 verify against a
// cached throwaway hash before throwing, so it costs the same as a wrong password — closing
// the login timing oracle for "does this email exist?". Both branches throw one generic
// "Invalid credentials".

buildPrincipal(staff: StaffWithGroup): AuthStaff
// AuthStaff = { staffId, email, isAdmin, permissions: Permission[] }

forgotPassword(email: string): Promise<void>
// Always resolves (no enumeration). For an enabled staff: invalidates prior unused
// reset tokens, creates one sha256-hashed token (1 h TTL), then dispatches the
// `password_reset` template via MailService.sendTemplateStrict (throws on failure).
// Fail-safe (GOAL_PUBLIC_SECURITY S1-4): on dispatch failure the just-issued token is
// invalidated and a NON-secret diagnostic is logged — the raw reset link is NEVER
// logged in any environment. The token is delivered in a URL fragment (#token=…).

resetPassword(token: string, newPassword: string): Promise<void>
// Atomic single-use consume (S1-5): a conditional updateMany on
// (tokenHash, usedAt IS NULL, not expired) must affect exactly one row before the
// password is changed, so concurrent/replayed use changes the password at most once.
// On success updates passwordHash and revokes all active refresh tokens in one tx.
// Invariant: MAIL_SERVICE_TOKEN is bound to a real MailService in AuthModule via a NARROW
// acyclic adapter — AuthModule registers only the 'mail' producer queue and provides
// MailService locally, WITHOUT importing MailModule (that would pull the
// Mail→Tickets→Sla→Mail module-load cycle at boot). The former `useValue: undefined`
// placeholder is removed, so reset mail is dispatched instead of the raw link being logged.
```

**Auxiliary auth services** (same module, injected `@Optional()` so a Redis outage degrades
gracefully):

- `LoginThrottleService` (`auth/login-throttle.service.ts`, S3-7) — Redis failure counter keyed
  `th:login:<HMAC-SHA256(email)>:<ip>`; `assertNotThrottled`/`recordFailure`/`clear`. Generic 429
  once the count reaches 10 in a 15-min sliding window; **fail-open**; never locks an account (per-IP
  key), and raw emails are never stored (HMAC). The HMAC key is HKDF-derived from the JWT secret
  (purpose-bound subkey, not the raw signing key), and the INCR+EXPIRE is one atomic Lua eval so a
  counter can never persist without a TTL. Used by `AuthService.login`.
- `TokenBlocklistService` (`auth/token-blocklist.service.ts`) — Redis jti blocklist for revoked
  access tokens (defense-in-depth atop the authoritative DB `authVersion` check); **fail-open**.

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

## ClientAuthService (`apps/api/src/modules/client-auth/client-auth.service.ts`)

Verified client (customer) auth (S2). Consumed by `ClientAuthController` and `ClientAuthGuard`.

```ts
requestLink(rawEmail: string): Promise<void>
// Always resolves (no enumeration). Queues a single-use magic-link only when the
// normalized email maps to EXACTLY ONE User.id that owns ≥1 ticket. Fragment URL;
// invalidates the token if mail dispatch fails.

verify(rawToken: string): Promise<{ sessionToken: string; expiresAt: Date }>
// Atomic single-use consume (updateMany count===1) → opens a ClientSession.

resolveSession(rawSession: string): Promise<{ userId: number } | null>
// Hash-lookup; null if revoked/expired. Used by ClientAuthGuard (fails closed 503 on error).

logout(rawSession): Promise<void>          // revoke the session
cleanupExpired(): Promise<{tokens; sessions}> // idempotent TTL sweep (scheduled hourly, S2-11)
```

`@ClientAuthenticated()` = `@Public()` + `@UseGuards(ClientAuthGuard)`; `@CurrentClient()` injects
`{ userId }`. Client ticket routes authorize by `Ticket.userId === client.userId`.

> **Email ownership identity (S2-2).** `normalizeEmail` (trim + lowercase) is canonical in
> `common/email.util.ts` (re-exported from `client-auth.service` for back-compat). `UsersService`
> normalizes on every `UserEmail` read/write (`findByEmail`/`findOrCreate`/`create`/`addEmail`), so
> all owner resolution — incl. `resolveUnambiguousOwner` and ticket create/inbound mail routing
> through `findOrCreate` — keys on one stable identity. Migration
> `20260716180000_normalize_user_email_ownership` normalizes existing rows (non-colliding) and
> backfills `Ticket.userId` for unambiguous emails. `auditUserEmailOwnership`
> (`seed/audit-user-email-ownership.ts`, `npm run audit:ownership`) is a READ-ONLY report of
> case-insensitive duplicate groups + ambiguous/orphan tickets; its `clean` flag gates enforcing a
> DB-level case-insensitive `UNIQUE(email)` (deferred until prod data is audited).

> **Reset-mail adapter (S1-3).** `AuthModule` does NOT import `MailModule` (that would pull the
> Mail→Tickets→Sla→Mail module-load cycle at boot). It registers the `mail` queue and provides a
> local `MailService` bound to `MAIL_SERVICE_TOKEN` — cycle-free; enqueues to the same Redis queue.

## MailService (`apps/api/src/modules/mail/mail.service.ts`)

```ts
send(opts: SendMailOptions): Promise<void>
// SendMailOptions = { to, subject, html?, text?, from? }
// Sends via nodemailer SMTP. Swallows errors (logs warning) to avoid crashing ticket flow.

renderTemplate(key: string, locale: string, vars: Record<string, string>): Promise<RenderedTemplate>
// RenderedTemplate = { subject, html, text }
// Loads EmailTemplate from DB by (key, locale); falls back to 'en'. Replaces {{key}} tokens.

sendTemplate(to: string | string[], templateKey: string, locale: string, vars: Record<string, string>): Promise<void>
// Convenience: renderTemplate() + send(). Best-effort (swallows failures).

sendTemplateStrict(to: string | string[], templateKey: string, locale: string, vars: Record<string, string>): Promise<void>
// Security-mail path (password reset / magic link): renderTemplate() + enqueue-or-inline,
// PROPAGATING any enqueue/SMTP failure instead of swallowing it. Callers fail closed on a
// throw (e.g. invalidate the issued token). Never logs the rendered subject/body.
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
