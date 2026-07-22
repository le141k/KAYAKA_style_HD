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

`TicketAccessPolicy` is injected by all staff-facing ticket/recipient/attachment/time/follow-up
paths. A controller passes its authenticated `TicketAccessActor`; trusted inbound/client/system
calls omit it. With an actor, all list/detail/mutation predicates are department scoped (empty
`DepartmentStaff` = unrestricted), cross-ticket operations validate both sides, and an unavailable
policy fails closed instead of falling back to an unscoped lookup.

Constructor: `(prisma: PrismaService, usersService: UsersService, slaService: SlaService, eventEmitter: EventEmitter2, …, ticketAccess?: TicketAccessPolicy)`

```ts
createTicket(dto: InternalCreateTicketInput, creatorStaffId?: number, actor?: TicketAccessActor): Promise<Ticket>
// Resolves/creates requester User by email, generates mask (TT-XXXXXX),
// creates first TicketPost, resolves default status/priority, writes CREATE audit log.
// LIFE-03: the CC/BCC `TicketRecipient` rows AND the CREATE `TicketAuditLog` row are now
// written INSIDE the same $transaction as the ticket + first post + attachment links — a
// crash after commit can no longer leave a ticket with no recipients / no audit row, and
// the P2002 (duplicate inboundMessageId) retry path returns the existing ticket so it never
// re-creates them.
// Trusted inbound callers may set incomingMessageId (not part of the HTTP schema).
// A duplicate non-empty ID returns the existing ticket without audit/mail/events.
// SLA wiring (implemented): calls slaService.resolvePlanForTicket(orgId) to set slaPlanId,
// then slaService.computeDueDates(slaPlanId, now) to set dueAt + resolutionDueAt.
// Fires eventEmitter.emit('ticket.created', { ticketId }) on completion.
// Invariant: every ticket has ≥1 post and a unique mask.

listTickets(query: ListTicketsQueryDto, actor?: TicketAccessActor): Promise<{ data: Ticket[]; total: number }>
// Filters: statusId, priorityId, departmentId, typeId, userId, ownerStaffId,
// unassigned, search (subject/mask/email/name). Excludes merged-away tickets.

getTicket(id: number, actor?: TicketAccessActor): Promise<TicketDetail>
// Includes: posts (with attachments), notes, watchers, tags, auditLogs (last 50).

getTicketByMask(mask: string, actor?: TicketAccessActor): Promise<TicketDetail>
// Same as getTicket but looks up by human-readable mask, e.g. "TT-000042".

reply(ticketId: number, dto: InternalReplyTicketInput, staffId?: number, actor?: TicketAccessActor): Promise<TicketPost | TicketNote>
// Atomically appends the post, adopts attachments, updates counters/status and writes audit.
// Sets firstResponseAt on first staff reply. Trusted inbound callers may set
// incomingMessageId; a duplicate returns the exact existing post with no side effects.
// If dto.isNote is true, delegates to addNote() and forwards attachmentIds.

addNote(ticketId: number, contents: string, staffId?: number, attachmentIds?: number[], actor?: TicketAccessActor): Promise<TicketNote>
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
// Calls checkBreaches(), then claims one SlaEscalationEvent under a SERIALIZABLE
// transaction before updating escalation state and re-reading enabled rules. `notify`
// creates a durable INTERNAL_NOTIFICATION command (not direct SMTP); stale/disabled
// rules and out-of-scope recipients fail closed. Other actions are priority/assign/note/
// mark_escalated and roll back together if the event cannot be materialized.

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

> **Superseded implementation notes.** The detailed bullets immediately below describe the
> pre-epoch/pre-claim implementation retained for migration history. They are not the current
> contract; use **Current inbound contract** below when changing or operating the service.

Durable, idempotent, fail-closed inbound pipeline backed by the **`InboundDelivery` ledger**.
Both transports (IMAP poll, `POST /api/inbound/pipe`) record every message in the ledger under a
UNIQUE `transportKey` before it is processed.

- **Cutover master gate:** `TELECOM_HD_INBOUND_DELIVERY_ENABLED` defaults to `false`. While it is
  false, the API does not start the IMAP supervisor or ledger drain, `pollNow()` is a no-op, and
  PIPE returns retryable 503 before its body parser. Existing `ACCEPTED`/`RETRY` ledger rows and
  all operator health/reconcile/quarantine/replay endpoints remain available; an attended
  configuration-only restart with the gate true is required before any ticket can be created.

- **Public:** `ingestRawMessage(source, departmentId?, externalId?, queueId?)` — PIPE ingress:
  records a ledger delivery (idempotent by `externalId` or content hash) and processes it inline.
  An optional `queueId` (from the `x-inbound-queue-id` header) binds the delivery to an
  `EmailQueue` — the queue's department routes the message and the delivery records the queue
  (unknown id → 400); the `transportKey` is scoped by the bound queue (`pipe:<queueId|->:…`).
  `pollNow()` — run one accept+drain cycle now (ops / live-IMAP verification).
- **Accept phase (IMAP, per queue):** discovers new UIDs uid-only, then `fetchOne`s each
  (source capped at `TELECOM_HD_INBOUND_MAX_SIZE_MB`) and accepts it in a short DB transaction
  whose row lock rechecks `isEnabled`, type, `syncState`, `mailboxEpoch`, `cursorGeneration`, and
  UIDVALIDITY. The transport key is `imap:<queueId>:<mailboxEpoch>:<uidValidity>:<uid>`; a stale
  poller cannot insert after a reconcile/identity cutover. It `create`s an
  `InboundDelivery` (state `ACCEPTED`, raw MIME stored) — `client.fetch(range, query, { uid: true })`
  with `{ uid: true }` as the **third** arg (real UID range). The `EmailQueue.lastSeenUid` cursor
  advances via a fixed-snapshot CAS ONLY after durable acceptance; the safe frontier never crosses
  the lowest failed UID, even when a higher UID was accepted first (**fail-closed** — no silent
  loss). A duplicate transport key is a no-op only when its full epoch/UID/content identity matches;
  any mismatch halts the queue with a durable collision audit.
- **Bootstrap barrier:** the starting cursor is captured **synchronously at connect** (not the
  first 60 s poll) via `TELECOM_HD_IMAP_BOOTSTRAP_POLICY` `FROM_NOW` (high-water, imports nothing)
  or `BACKFILL` (rewinds by `TELECOM_HD_IMAP_BACKFILL_LIMIT`). Never fails open to `1:*`.
- **UIDVALIDITY:** on a server UID-space reset the queue flips to
  `EmailQueue.syncState = NEEDS_RECONCILIATION` and polling **halts** (fail-closed) until an
  operator re-bootstraps (clear `uidValidity`).
- **Explicit reconcile:** the API requires `expectedCursorGeneration` and returns
  server-computed `allowedModes` from its typed `reconcileCause`. FROM_NOW/BACKFILL moves the
  queue to `BOOTSTRAPPING`, captures UIDVALIDITY plus exact `UIDNEXT - 1` under the mailbox lock,
  and writes the baseline in a second epoch/generation CAS before returning success. BACKFILL
  enumerates actual existing UIDs under that same lock; it never uses `boundary - N`.
- **Drain phase (only while the master gate is enabled):** a `setInterval` (30 s, plus one
  **startup drain** for crash recovery) processes
  `ACCEPTED`/`RETRY` deliveries in id order; claims each with a **lease** (CAS: `ACCEPTED`, a
  `RETRY` whose `nextAttemptAt` is due, or a `PROCESSING` whose `leaseExpiresAt` passed →
  `PROCESSING` + a fresh per-claim `leaseOwner` token/`leaseExpiresAt`). The **claim CAS increments
  `attempts`** (not the settle) — so a delivery whose processing repeatedly outlives its lease still
  exhausts its budget — and it enforces the `RETRY` `nextAttemptAt` schedule **in the CAS itself**, so
  no caller (inline ingest, racing worker) can claim a not-yet-due RETRY and burn an attempt early.
  A **lease heartbeat** (`setInterval`, CAS-gated on our token, unref'd) extends the lease while a
  healthy-but-slow message (large parse + attachment upload) is processed, then is cleared in
  `finally`. Every terminal/retry write goes through a lease-gated `settle()` (`leaseOwner = us AND
state = PROCESSING`): a **0-row settle** means the lease was lost mid-processing (another worker
  reclaimed) — the result is dropped and logged, never clobbering the winner. A delivery is thus
  **never stranded in `PROCESSING`**. Success → `PROCESSED` (+`ticketId`/`postId`); transient error →
  `RETRY` (exponential backoff `60s·2^(n-1)`); a **truncated** (oversized) IMAP fetch or other
  permanent input error → **fast `QUARANTINED`** at once (a truncated fetch is never partially
  ticketed — replay must re-fetch the original); attempts ≥ `TELECOM_HD_INBOUND_MAX_ATTEMPTS` (5) →
  `QUARANTINED`. Raw MIME is **always retained** — a quarantine never discards a message.
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
- **Routing / idempotency (P1-E logical claim):** each transport copy remains a separate
  `InboundDelivery` and stores its non-unique `observedMessageId`, `messageIdHash`, `semanticHash`
  and immutable route snapshot. A real RFC Message-ID is normalized, SHA-256 hashed and claimed in
  one transaction through `InboundMessageClaim(messageIdHash PK, winnerDeliveryId UNIQUE)`. The
  semantic hash contains normalized From/To/Cc/Reply-To, subject, text/HTML and attachment metadata
  - content hashes; it deliberately excludes per-hop `Received`, `Return-Path` and `Delivered-To`.
    Same real ID + same semantic content → loser `SKIPPED`; same ID + differing (or legacy unknown)
    semantic content → loser `QUARANTINED` with a durable `mail.message_id_conflict` audit.
    `TicketPost.inboundMessageId` is the independent inbound retry backstop; non-unique
    `TicketPost.messageId` remains available only for RFC threading, so a spoofed staff outbound
    ID cannot suppress an inbound delivery. Headerless mail has **no logical
    content claim**: it receives an internal post key from its exact transport key, so two different
    IMAP UIDs with identical bytes become two tickets, while a retry of one transport remains
    idempotent. A headerless re-fetch after UIDVALIDITY reset may visibly duplicate — this is the
    intentional safe trade-off over silent loss. During the forward-only expand/contract rollout,
    legacy `InboundDelivery.messageId @unique` remains as compatibility state; it is not written by
    new runtime and cannot be removed before real-PostgreSQL backfill/cutover verification. Deploy
    must quiesce all old inbound workers first: old headerless content-derived keys and new
    transport-derived keys are deliberately never mixed in a rolling worker fleet.
- **Deterministic owner:** before any ticket work, enabled queues matching normalized To/Cc or a
  trusted envelope recipient are sorted by `routingPriority` (ascending), then queue `id`. The chosen
  queue/department is persisted once on the logical claim and every copy reuses it, independent of
  poller arrival order. No match falls back explicitly to the receiving queue/default department and
  records `mail.route_fallback` audit metadata.
- **Liveness + retention (advisory):** the supervisor stamps `EmailQueue.lastConnectedAt` on a
  successful connect, the poller `lastPollAt` each cycle, and the accept path `lastAcceptedAt` on a
  durable record (best-effort `stampQueue`, never breaks a poll; surfaced by health). A **raw-MIME
  retention prune** (`pruneRawMime`, `setInterval` hourly + once at startup, unref'd) nulls the
  inline `rawMime` (setting `rawPrunedAt`) of terminal `PROCESSED`/`SKIPPED` deliveries older than
  `TELECOM_HD_INBOUND_RAW_RETENTION_DAYS` (default 30; 0 disables), keeping metadata + `contentHash`;
  `QUARANTINED` rows are never pruned (raw MIME is needed to replay).
- TODO: IMAP IDLE push.

### Current inbound contract

- IMAP acceptance is a transaction fenced by enabled IMAP queue, `mailboxEpoch`,
  `cursorGeneration`, `syncState=OK` and `uidValidity`. Transport key is
  `imap:<queue>:<epoch>:<uidValidity>:<uid>`; stale pollers cannot insert after an identity or
  reconcile boundary. Cursor safe frontier uses the same fixed snapshot.
- Reconcile is server-side cause/mode gated and returns `allowedModes`. `FROM_NOW` and BACKFILL
  obtain UIDNEXT/UIDVALIDITY under mailbox lock and persist their baseline before HTTP success.
- PIPE requires secret, enabled PIPE queue id and normalized delivery id. The factory middleware
  validates secret before a bounded raw parser; transport key stores SHA-256(delivery id), and the
  trusted queue address is snapshotted as `envelopeTo`.
- `InboundDelivery` records each transport copy. Real Message-ID logical identity is an atomic
  `InboundMessageClaim`; `observedMessageId`/semantic hash stay on every copy. Headerless IMAP
  messages use transport identity, never content hash alone.
- Poll and drain are single-flight. Liveness distinguishes connection attempt/connect/disconnect,
  poll started/completed and accepted. Large raw MIME is stored privately under uploads using a
  pending marker + fsync/rename + bounded DB-proven orphan reaper; user-visible storage errors are
  sanitized.

---

## EmailQueueService (`apps/api/src/modules/mail/email-queue.service.ts`)

> **Superseded implementation notes.** The following legacy pseudo-signatures predate mandatory
> reconcile audit transactions and split mail permissions. The current contract is below.

Consumed by: `EmailQueueController`. Owns queue CRUD (password `passwordEnc` never returned) plus
the inbound operator actions. Injects `MailAccessPolicy` and `InboundAuditService` (`@Optional()`).
`MailAccessPolicy` makes only global administrators unrestricted. A non-admin gets an explicit
`DepartmentStaff` allow-list (an empty list is deny-all, matching ticket ACL behavior):
queue predicates require an allowed non-null `EmailQueue.departmentId`; delivery predicates require
an allowed non-null acceptance-time `InboundDelivery.departmentId` and, when bound to a queue, an
allowed current queue department too. ID mutations repeat their scoped SQL predicate at write time
to prevent a read-then-write scope race.

```ts
list() / get(id) / create(dto) / delete(id)

update(id, dto): Promise<SafeQueue>
// Mailbox-identity guard: changing host/port/username/useTls or crossing the IMAP boundary
// uses an optimistic CAS to bump mailboxEpoch + cursorGeneration, clear the cursor, and halt
// with MAILBOX_IDENTITY_CHANGED — including before first bootstrap. Password-only change: exempt.

reconcile(id, dto, actor?): Promise<{ reconciled, mode, queue, detail }>
// Refuses a non-IMAP queue (400). RESUME_MIGRATED reads the legacy Setting cursor
// (imap/state:<id> primary — UIDVALIDITY+watermark rewound past still-pending UIDs; or the bare
// imap/lastSeenUid:<id> fallback, refused when it has no UIDVALIDITY) → OK. FROM_NOW/BACKFILL
// require a server-allowed typed cause + expectedCursorGeneration, synchronously capture an
// exact IMAP baseline under lock, and return success only after the second CAS writes it. Every
// accepted request has mail.reconcile_requested plus exactly one completed/failed audit row in
// the same state-transition transactions.

health(now?): Promise<{ queues[], ledger, alerts[], checkedAt }>
// Per-IMAP-queue sync state + liveness (lastConnectedAt/lastPollAt/lastAcceptedAt) and the ledger
// backlog/staleness (backlog, byState, stalledProcessing, oldestPendingAt, lastProcessedAt).
// Computes alerts[]: queue_halted (critical), quarantine, stalled_processing, aged_backlog (>15m).

listQuarantined() / replayQuarantined(deliveryId, actor?)
// replayQuarantined resets a QUARANTINED delivery → ACCEPTED (attempts 0, lease cleared) so the
// drain reprocesses it (404 if not quarantined) and audits it (action mail.quarantine_replay).
```

**Scheduled health-alert emitter.** `onModuleInit` starts a `setInterval` (5 min, unref'd) that runs
`health()` and logs each alert (`this.logger.error` for `critical`, `warn` otherwise) — so a halted
queue / quarantine backlog / stalled processing surfaces to a log-based monitor without an operator
polling the endpoint. Cleared in `onModuleDestroy`.

### Current queue/operator contract

- Queue update atomically advances mailbox epoch for IMAP identity/transport transitions; it does
  not rely on an in-memory epoch. Password-only changes do not invalidate the mailbox snapshot.
- Reconcile requires expected generation and a server-allowed mode. Request, terminal completion or
  failure audit entries are written with their conditional state transitions; a CAS loser is 409 and
  produces no false audit.
- `listQuarantined(query)` returns server pagination/filter metadata only. Detail returns audit and
  `replayAllowed`/block reason, never raw bytes or `rawStorageKey`. Replay requires reason + row
  version and writes state/audit in one transaction.
- `health()` includes quarantine bytes, raw-storage reserve and collision alerts as well as queue
  liveness. All mail operator routes use `mail.view`, `mail.replay`, `mail.reconcile` or
  `mail.configure`; backend guard is authoritative.

## InboundAuditService (`apps/api/src/modules/mail/inbound-audit.service.ts`)

`InboundAuditService` remains suitable for non-critical observability. It is **not** the authority
for reconcile/replay: correctness-critical operator state transitions insert `InboundAuditLog`
directly through the same Prisma transaction, so an audit failure rolls back that action.

Consumed by: `EmailQueueService`. Append-only writer for `InboundAuditLog` — the durable audit trail
for inbound operator actions, kept separate from `RbacAuditLog` so mail-ops history is queryable per
queue/delivery.

```ts
log(entry): Promise<void>
// Non-critical observability helper. May log a failed insert, but MUST NOT be used for a
// correctness-critical reconcile/replay transition. Those paths call tx.inboundAuditLog.create
// in their owning transaction. Actions also include mail.transport_collision and
// mail.message_id_conflict.

list({ page, limit }): Promise<[rows, total]>   // newest first (id desc)
```

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

`evaluate()` loads all enabled `Workflow` rows (ordered by `sortOrder`), runs the shared ordered
rule-chain projection against the ticket, and calls `applyActions()` for each matching workflow.
Scalar mutations made by an earlier matching rule are visible to later criteria. `send_email` is
never sent by this listener: `TicketsService` stores an immutable `WorkflowEmailEvent` snapshot in
the source ticket transaction, and `WorkflowEmailEventService` materializes idempotent durable
outbox rows with a lease/retry/quarantine state machine. Workflow assignment writes its ticket
update, audit and internal-notification command atomically.

**Criteria operators:** `eq | neq | contains | gt | lt` on any scalar ticket field.

**Action types:** `change_department | change_owner | change_status | change_priority | change_type | add_tag | add_note | send_email`.
New `send_email` bodies are validated; malformed legacy data is preserved as operator-visible
quarantine evidence rather than rolling back a customer mutation or sending partial rule output.

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
run(id: number, actor: TicketAccessActor): Promise<AggregatedRows>
execute(def: Definition, actor: TicketAccessActor): Promise<AggregatedRows>
dashboard(actor: TicketAccessActor): Promise<{ total, resolved, byStatus, byPriority }>
```

Definition schema supports: `source: 'tickets'`, `groupBy?: statusId|priorityId|departmentId|typeId|ownerStaffId|creationMode`, `filters`, `metric: 'count'`.

`ReportCompiler.compile()` requires a `TicketAccessActor` and derives its `TicketWhereInput` scope
from `TicketAccessPolicy`; it applies it directly for `tickets`, and through the parent `ticket`
relation for `ticketPosts` / `ticketAuditLogs`. There is no unscoped compiler execution path.
`ReportSchedule.ownerStaffId` is mandatory for new schedules;
the worker re-loads that owner, checks enabled + `report.run`, derives its current department scope,
and disables unsafe legacy/revoked schedules before any recipient email is sent.

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

| Queue      | Job                       | Producer                 | Consumer             | Purpose                                                                                                                         |
| ---------- | ------------------------- | ------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `sla`      | `scan` (repeatable, 60 s) | `SlaModule` on init      | `SlaProcessor`       | Periodic SLA breach scan → `SlaService.runPeriodicCheck()`                                                                      |
| `workflow` | `auto-close` (repeatable) | `WorkflowModule` on init | `AutoCloseProcessor` | Close idle pending tickets after `TELECOM_HD_AUTO_CLOSE_DAYS` days (default 7); queues one durable `ticket_auto_closed` command |
| `mail`     | per-message send job      | `MailService`            | `MailProcessor`      | Durable outbox wake-up; PostgreSQL scan/recovery remains authoritative for SMTP delivery                                        |

Inbound mail is NOT on a BullMQ queue — it runs on in-process `setInterval` timers:
`InboundMailService` polls IMAP (60 s) and drains the ledger (30 s, + a startup drain for crash
recovery) and prunes raw MIME (hourly, + at startup); `EmailQueueService` emits inbound health
alerts (5 min). IMAP IDLE push is a future TODO.

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
