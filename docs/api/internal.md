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
// Internal service result: AuthController stores the JWT pair only in HttpOnly cookies and returns
// `{staff}` to the browser. No JWT appears in login/refresh JSON.
// Validates credentials, issues JWT pair, persists argon2-hashed refresh token, updates lastLoginAt.
// S3-7: before validating, asserts the caller is under the login-abuse throttle (LoginThrottleService,
// keyed by trusted client IP + HMAC(email)); records a failure on bad credentials and clears the
// counter on success. Over the threshold it throws a generic 429 (never an account-lock). Fail-open:
// a Redis outage does not block logins. Both the throttle 429 and the credential failure are generic
// so nothing about account existence or lock state is disclosed.
// Legacy Staff.failedLoginAttempts/lockedUntil columns are not read or written at runtime.

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
// The token stores Staff.authVersion at issuance. One transaction conditionally consumes the
// unused/live token, updates only an enabled Staff whose authVersion still matches, increments the
// version, and revokes refresh/reset siblings. An admin disable/password/logout race therefore
// either wins first and rejects reset, or runs after reset and remains authoritative.
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
- `CsrfService` (`auth/csrf.service.ts`) — HKDF-separated HMAC signing for the readable
  double-submit cookie. `CsrfGuard` requires an exact same origin plus matching valid
  `X-CSRF-Token` on cookie-authenticated mutations; login/client-verify require exact origin even
  before a cookie exists.

---

## SessionRevocationService (`apps/api/src/auth/session-revocation.service.ts`)

Consumed by: `StaffService`. Exported by `AuthModule` (`@Global`).

```ts
revokeAllForStaff(staffId: number): Promise<void>
// Marks all active RefreshTokens revoked AND sets a per-staff access-token cutoff
// (TokenBlocklistService.revokeStaffAccessBefore) so already-issued access tokens
// are rejected immediately. Used on role/password/disable changes.

revokeAllForGroup(groupId: number): Promise<void>
// Same, for every member of a group — used when the group's permission set changes.
```

Backed by `TokenBlocklistService.revokeStaffAccessBefore(staffId, ttl)` /
`isStaffTokenStale(staffId, iat)` (Redis key `th:staffcutoff:<staffId>` = epoch
seconds, TTL = access-token lifetime). `JwtAuthGuard` rejects any access token
whose `iat` predates the cutoff. Fail-open if Redis is down (short access TTL +
durable refresh revocation are the backstops).

**Invariant:** an access-affecting staff change (role, password, `isEnabled→false`)
or a group permission change MUST revoke the affected sessions.

## RbacAuditService (`apps/api/src/modules/staff/rbac-audit.service.ts`)

Consumed by: `StaffService`, `StaffController` (read). Writes an append-only
`RbacAuditLog` row for every staff/group RBAC change.

```ts
log(entry): Promise<void>
// action ∈ staff.create | staff.update | staff.role_change | staff.password_reset |
//          staff.enable | staff.disable | group.create | group.update |
//          group.permissions_change | group.delete
// Best-effort: a failed insert is logged, never propagated (won't roll back the change).

list({ page, limit }): Promise<{ data: RbacAuditLog[]; total }>  // newest first
```

## StaffService (`apps/api/src/modules/staff/staff.service.ts`)

Key invariants beyond CRUD:

- **Privilege escalation:** a non-admin actor cannot assign/move a staff member
  into an `isAdmin` group (403).
- **Last active administrator:** cannot disable or demote the last enabled admin
  (403); cannot delete the last `isAdmin` group (403).
- **Session revocation + audit:** role/password/disable changes call
  `SessionRevocationService` and write an `RbacAuditLog` entry; group permission
  changes revoke all members' sessions.

---

## TicketsService (`apps/api/src/modules/tickets/tickets.service.ts`)

Consumed by: `TicketsController`, `AlarisService`, `InboundMailService`.

Constructor: `(prisma: PrismaService, usersService: UsersService, slaService: SlaService, eventEmitter: EventEmitter2)`

```ts
createTicket(dto: InternalCreateTicketInput, creatorStaffId?: number): Promise<Ticket>
// Resolves/creates requester User by email, generates mask (TT-XXXXXX),
// creates first TicketPost, resolves default status/priority, writes CREATE audit log.
// Trusted inbound callers may set incomingMessageId (not part of the HTTP schema).
// A duplicate non-empty ID returns the existing ticket without audit/mail/events.
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

reply(ticketId: number, dto: InternalReplyTicketInput, staffId?: number): Promise<TicketPost | TicketNote>
// Atomically appends the post, adopts attachments, updates counters/status and writes audit.
// Sets firstResponseAt on first staff reply. Trusted inbound callers may set
// incomingMessageId; a duplicate returns the exact existing post with no side effects.
// If dto.isNote is true, delegates to addNote() and forwards attachmentIds.

addNote(ticketId: number, contents: string, staffId?: number, attachmentIds?: number[]): Promise<TicketNote>
// Internal-only note; note creation, attachment adoption, ticket flags and audit
// commit in one transaction.

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
// invalidates the token if mail dispatch fails. A per-owner PostgreSQL advisory xact
// lock makes the mail cap + invalidate-old/create-new transition race-safe.

verify(rawToken: string): Promise<{ sessionToken: string; expiresAt: Date }>
// Atomic single-use consume → opens a version-stamped ClientSession only when the user
// is enabled and token.clientAuthVersion still matches User.clientAuthVersion.

resolveSession(rawSession: string): Promise<{ userId: number } | null>
// Hash-lookup; null if revoked/expired/disabled/version-stale. Used by ClientAuthGuard
// (fails closed 503 on storage error).

logout(rawSession): Promise<void>          // revoke the session
cleanupExpired(): Promise<{tokens; sessions}> // idempotent TTL sweep (scheduled hourly, S2-11)
```

`@ClientAuthenticated()` = `@Public()` + `@UseGuards(ClientAuthGuard)`; `@CurrentClient()` injects
`{ userId }`. Client ticket routes authorize by `Ticket.userId === client.userId`.

> **Email ownership identity (S2-2).** `normalizeEmail` (explicit ASCII trim + lowercase) is canonical in
> `common/email.util.ts` (re-exported from `client-auth.service` for back-compat). `UsersService`
> normalizes on every `UserEmail` read/write (`findByEmail`/`findOrCreate`/`create`/`addEmail`), so
> all owner resolution — incl. `resolveUnambiguousOwner` and ticket create/inbound mail routing
> through `findOrCreate` — keys on one stable identity. Migration
> `20260716180000_normalize_user_email_ownership` normalizes existing rows (non-colliding) and
> backfills `Ticket.userId` for unambiguous emails. `auditUserEmailOwnership`
> (`seed/audit-user-email-ownership.ts`, `npm run audit:ownership`) is a READ-ONLY report of
> case-insensitive duplicate groups + ambiguous/orphan tickets. Migration
> `20260717000000_client_identity_invariant` fails and rolls back unless that audit is CLEAN, then
> installs the normalized CHECK/expression UNIQUE. Owner lookup uses DB `lower(btrim(...))` and
> fails closed on every legacy case/whitespace collision even before the invariant is installed.

> `User.clientAuthVersion` is stamped into every client login token/session. User enable-state and
> email mutations share the same per-user advisory xact lock as issuance/verification, bump the
> version and revoke active auth material in the same transaction. An old link/session therefore
> remains invalid after disable → re-enable or email removal.

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

Durable, idempotent, fail-closed inbound pipeline backed by the **`InboundDelivery` ledger**.
Both transports (IMAP poll, `POST /api/inbound/pipe`) record every message in the ledger under a
UNIQUE `transportKey` before it is processed.

- **Public:** `ingestRawMessage(source, departmentId, externalId?)` — PIPE ingress: records a
  ledger delivery (idempotent by `externalId` or content hash) and processes it inline.
  `pollNow()` — run one accept+drain cycle now (ops / live-IMAP verification).
- **Accept phase (IMAP, per queue):** discovers new UIDs uid-only, then `fetchOne` each in
  ascending order (source capped at `TELECOM_HD_INBOUND_MAX_SIZE_MB`) and `create`s an
  `InboundDelivery` (state `ACCEPTED`, raw MIME stored) — `client.fetch(range, query, { uid: true })`
  with `{ uid: true }` as the **third** arg (real UID range). The `EmailQueue.lastSeenUid` cursor
  advances via a **monotonic CAS** (`updateMany where lastSeenUid < cursor`) ONLY after durable
  acceptance; a fetch/DB error stops the poll without advancing (**fail-closed** — no silent loss).
  A duplicate `transportKey` (`P2002`) is an idempotent no-op (multi-poller / re-poll safe; a
  best-effort Postgres advisory lock avoids concurrent fetching but is not required for correctness).
- **Bootstrap barrier:** the starting cursor is captured **synchronously at connect** (not the
  first 60 s poll) via `TELECOM_HD_IMAP_BOOTSTRAP_POLICY` `FROM_NOW` (high-water, imports nothing)
  or `BACKFILL` (rewinds by `TELECOM_HD_IMAP_BACKFILL_LIMIT`). Never fails open to `1:*`.
- **UIDVALIDITY:** on a server UID-space reset the queue flips to
  `EmailQueue.syncState = NEEDS_RECONCILIATION` and polling **halts** (fail-closed) until an
  operator re-bootstraps (clear `uidValidity`).
- **Drain phase:** processes `ACCEPTED`/`RETRY` deliveries in id order; claims each with a
  **lease** (CAS: `ACCEPTED|RETRY`, or a `PROCESSING` whose `leaseExpiresAt` passed → `PROCESSING`
  - `leaseOwner`/`leaseExpiresAt`). Every terminal/retry write is itself lease-gated
    (`leaseOwner = us`), so a crashed worker's stalled write can't clobber the one that reclaimed it,
    and a delivery is **never stranded in `PROCESSING`** (a stale lease is reclaimed on the next drain;
    a startup drain kicks recovery immediately). Success → `PROCESSED` (+`ticketId`/`postId`);
    transient error → `RETRY` (exponential backoff); a permanent input error (malformed / oversized
    MIME) → `QUARANTINED` at once; attempts ≥ `TELECOM_HD_INBOUND_MAX_ATTEMPTS` (5) → `QUARANTINED`.
    Raw MIME is **always retained** — a quarantine never discards a message.
- **Security (preserved from the hardened baseline):** MIME source bytes, parsed
  subject/body/addresses/references/filenames and parser concurrency are bounded; a threaded reply
  (RFC `References` or `TT-XXXXXX` mask) requires the normalized sender to be a ticket participant
  (requester, linked `UserEmail`, or `TicketRecipient`) — possessing a Message-ID or guessing a mask
  is never authorization. Loop/bounce guard (A5) suppresses mail from our own configured mailboxes.
- **Upgrade/cutover:** the ledger migration halts every already-enabled IMAP queue
  (`syncState = NEEDS_RECONCILIATION`) so a deploy can't FROM_NOW-bootstrap over an in-flight legacy
  cursor and skip mail. `bootstrapQueue` refuses to run on a halted queue — an operator reconciles
  explicitly via `POST /api/admin/email-queues/:id/reconcile`, which reads the legacy `Setting`
  state (`imap/state:<id>` primary, `imap/lastSeenUid:<id>` fallback) and carries UIDVALIDITY +
  watermark forward before clearing the halt.
- **Routing / idempotency:** de-dups by effective Message-ID — the RFC id, or a deterministic
  `<inbound-<sha256>@23telecom.local>` synthesised from the content hash when absent — so a retry
  or IMAP+PIPE double-delivery never double-posts even without a Message-ID. The Message-ID is
  written **atomically** with the ticket/post create (`TicketsService.reply()` / `createTicket()`
  accept an internal `incomingMessageId`); a unique `TicketPost.messageId` plus the ledger's unique
  `messageId`/`transportKey` make redelivery an idempotent no-op. Subject-mask threading is
  fail-closed: unresolved / unauthorized sender → new ticket; a DB error propagates (delivery
  retried, never a silent duplicate ticket).
- TODO: IMAP IDLE push; externalise raw MIME for very large messages; per-queue backfill policy.

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
