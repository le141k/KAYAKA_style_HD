# REST API endpoints — 23 Telecom Help Desk

> Living doc — must mirror the Swagger spec at `/api/docs`. Keep in sync with controllers
> (see `CLAUDE.md` → "Living docs"). _(This index is regenerated from the live OpenAPI spec
> at `http://localhost:4000/api/docs-json` and cross-checked against controllers; do not
> let it drift from actual routes.)_

All routes are under the `/api` global prefix.

**Auth column legend:**

- 🔓 public (no auth)
- 🔑 shared-secret (`x-alaris-secret` header, not JWT)
- 🔒 staff session cookie (Bearer remains accepted for explicit external/test clients) + listed permission key

---

## Auth

| Method | Path              | Auth                          | Body                | Returns                  |
| ------ | ----------------- | ----------------------------- | ------------------- | ------------------------ |
| GET    | /api/auth/csrf    | 🔓                            | —                   | `{csrfToken}` + cookie   |
| POST   | /api/auth/login   | 🔓 exact-origin               | `{email, password}` | `{staff}` + auth cookies |
| POST   | /api/auth/refresh | refresh cookie + CSRF         | —                   | `{ok: true}`             |
| POST   | /api/auth/logout  | 🔒 _(any valid staff)_ + CSRF | —                   | 204 No Content           |
| GET    | /api/auth/me      | 🔒 _(any valid staff)_        | —                   | Current staff principal  |

> **Login throttle (S3-7).** `POST /api/auth/login` returns a generic **429** after 10 failed
> attempts in a 15-min window per client IP + `HMAC(email)` (in addition to the per-IP
> `@Throttle(5/60s)`). It never locks an account and discloses nothing about account/lock state;
> fail-open on a Redis outage. Legacy DB `lockedUntil`/failure counters are ignored, so anonymous
> failures cannot globally lock a known account. Browser JWTs are returned only as host-only,
> HttpOnly cookies; unsafe cookie-authenticated requests require exact origin plus the signed
> `X-CSRF-Token` double-submit value.

---

## Tickets

> **Client access (GOAL_PUBLIC_SECURITY S2).** `GET /api/tickets/my`,
> `GET /api/tickets/public/{id}` and `POST /api/tickets/public/{id}/reply` now require a
> **verified client session** (`@ClientAuthenticated` → `th_client` cookie); they authorize
> strictly by `Ticket.userId === session.userId` (no `?email=`), returning 401 without a
> session and the same 404 for wrong-owner / unmapped / missing tickets. Obtain a session via
> the `/api/client-auth/*` routes below.
>
> `POST /api/tickets/public` (create) and `POST /api/attachments/upload/public` remain gated by
> `ClientPortalGuard` (fail-closed **404 in production** until S4 abuse controls land; override
> with `TELECOM_HD_CLIENT_PORTAL_ENABLED=true`, not before S4). Dev/test are unaffected.

## Client auth (verified customer sessions — S2)

| Method | Path                                  | Auth              | Body                   | Returns                                                                                                                           |
| ------ | ------------------------------------- | ----------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POST   | /api/client-auth/request-link         | 🔓 (throttled)    | `{email}`              | Always 202 `{message}` — no account enumeration                                                                                   |
| POST   | /api/client-auth/verify               | 🔓 (throttled)    | `{token}` (from #frag) | 200 `{ok, expiresAt}` + sets HttpOnly `th_client`                                                                                 |
| POST   | /api/client-auth/logout               | 🔑 client session | —                      | 204; revokes the session + clears the cookie                                                                                      |
| GET    | /api/client-auth/me                   | 🔑 client session | —                      | `{userId}`                                                                                                                        |
| GET    | /api/attachments/client/{id}/download | 🔑 client session | —                      | File stream — owner-scoped (post attachment, non-third-party, `post.ticket.userId === session.userId`); same 404 otherwise (S2-8) |

| Method | Path                                 | Auth               | Body                                                                                                                          | Returns                                                     |
| ------ | ------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | /api/tickets/public                  | 🔓                 | `{subject, contents, requesterEmail, requesterName?, departmentId?, customFields?}`                                           | Created ticket                                              |
| GET    | /api/tickets                         | 🔒 `ticket.view`   | — (query: statusId, priorityId, departmentId, typeId, userId, ownerStaffId, unassigned, search, page, limit, sortBy, sortDir) | `{data: Ticket[], total: number}`                           |
| POST   | /api/tickets                         | 🔒 `ticket.create` | `{subject, contents, requesterEmail, requesterName, departmentId, ...}`                                                       | Created ticket                                              |
| GET    | /api/tickets/{id}                    | 🔒 `ticket.view`   | —                                                                                                                             | Ticket with posts, notes, watchers, tags, audit log         |
| GET    | /api/tickets/by-mask/{mask}          | 🔒 `ticket.view`   | —                                                                                                                             | Ticket with posts, notes, watchers, tags (e.g. `TT-000042`) |
| POST   | /api/tickets/{id}/reply              | 🔒 `ticket.reply`  | `{contents, isHtml?, isNote?, isEmailed?, isThirdParty?, creationMode?, ipAddress?}`                                          | Created post                                                |
| POST   | /api/tickets/{id}/notes              | 🔒 `ticket.note`   | `{contents, isHtml?}`                                                                                                         | Created note (internal only)                                |
| PATCH  | /api/tickets/{id}/assign             | 🔒 `ticket.assign` | `{ownerStaffId: number \| null}`                                                                                              | Updated ticket                                              |
| PATCH  | /api/tickets/{id}/status             | 🔒 `ticket.edit`   | `{statusId: number}`                                                                                                          | Updated ticket                                              |
| PATCH  | /api/tickets/{id}/priority           | 🔒 `ticket.edit`   | `{priorityId: number}`                                                                                                        | Updated ticket                                              |
| PATCH  | /api/tickets/{id}/type               | 🔒 `ticket.edit`   | `{typeId: number \| null}`                                                                                                    | Updated ticket                                              |
| POST   | /api/tickets/{id}/merge              | 🔒 `ticket.merge`  | `{targetTicketId: number}`                                                                                                    | Target ticket (posts moved, source marked merged)           |
| POST   | /api/tickets/{id}/split              | 🔒 `ticket.merge`  | `{postIds: number[], subject: string, departmentId?}`                                                                         | New ticket (posts moved from source; SLA re-computed)       |
| POST   | /api/tickets/{id}/watchers           | 🔒 `ticket.view`   | `{staffId: number}`                                                                                                           | 204 No Content                                              |
| DELETE | /api/tickets/{id}/watchers/{staffId} | 🔒 `ticket.view`   | —                                                                                                                             | 204 No Content                                              |
| POST   | /api/tickets/{id}/tags               | 🔒 `ticket.edit`   | `{name: string}`                                                                                                              | 204 No Content                                              |
| DELETE | /api/tickets/{id}/tags/{name}        | 🔒 `ticket.edit`   | —                                                                                                                             | 204 No Content                                              |

---

## Reference Data (Ticket Statuses, Priorities, Types)

| Method | Path                        | Auth                | Body                                           | Returns            |
| ------ | --------------------------- | ------------------- | ---------------------------------------------- | ------------------ |
| GET    | /api/ticket-statuses        | 🔒 `ticket.view`    | —                                              | `TicketStatus[]`   |
| POST   | /api/ticket-statuses        | 🔒 `admin.settings` | `{title, color?, isDefault?, markAsResolved?}` | Created status     |
| PATCH  | /api/ticket-statuses/{id}   | 🔒 `admin.settings` | Partial status fields                          | Updated status     |
| DELETE | /api/ticket-statuses/{id}   | 🔒 `admin.settings` | —                                              | 204 No Content     |
| GET    | /api/ticket-priorities      | 🔒 `ticket.view`    | —                                              | `TicketPriority[]` |
| POST   | /api/ticket-priorities      | 🔒 `admin.settings` | `{title, color?, displayOrder?}`               | Created priority   |
| PATCH  | /api/ticket-priorities/{id} | 🔒 `admin.settings` | Partial priority fields                        | Updated priority   |
| DELETE | /api/ticket-priorities/{id} | 🔒 `admin.settings` | —                                              | 204 No Content     |
| GET    | /api/ticket-types           | 🔒 `ticket.view`    | —                                              | `TicketType[]`     |
| POST   | /api/ticket-types           | 🔒 `admin.settings` | `{title, displayOrder?}`                       | Created type       |
| PATCH  | /api/ticket-types/{id}      | 🔒 `admin.settings` | Partial type fields                            | Updated type       |
| DELETE | /api/ticket-types/{id}      | 🔒 `admin.settings` | —                                              | 204 No Content     |

---

## Staff & RBAC

| Method | Path                   | Auth              | Body                                                               | Returns                                                                                                             |
| ------ | ---------------------- | ----------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| GET    | /api/staff/rbac        | 🔒 `staff.manage` | —                                                                  | `{permissions[], roles[]}` catalog + built-in role templates (Administrator/Manager/Agent)                          |
| GET    | /api/staff/audit       | 🔒 `staff.manage` | — (query: page, limit)                                             | `{data: RbacAuditLog[], total}` (newest first)                                                                      |
| GET    | /api/staff/groups      | 🔒 `staff.manage` | —                                                                  | `StaffGroup[]`                                                                                                      |
| GET    | /api/staff/groups/{id} | 🔒 `staff.manage` | —                                                                  | `StaffGroup`                                                                                                        |
| POST   | /api/staff/groups      | 🔒 `staff.manage` | `{title, isAdmin?, permissions?}` (unknown perm key → 400)         | Created group; a delegated non-admin may grant only permissions they already hold                                   |
| PATCH  | /api/staff/groups/{id} | 🔒 `staff.manage` | Partial group fields (`isAdmin` immutable; unknown perm key → 400) | Updated group — a permissions change revokes all group members' sessions; delegated authority is subset-only        |
| DELETE | /api/staff/groups/{id} | 🔒 `staff.manage` | —                                                                  | 204; 409 if members assigned; 403 if protected/last admin group                                                     |
| GET    | /api/staff             | 🔒 `staff.manage` | — (query: search, groupId, enabled, page, limit)                   | `{data: Staff[], total}`                                                                                            |
| GET    | /api/staff/{id}        | 🔒 `staff.manage` | —                                                                  | `Staff`                                                                                                             |
| POST   | /api/staff             | 🔒 `staff.manage` | `{email, username, firstName, lastName, password, staffGroupId}`   | Created staff member; delegated authority is subset-only                                                            |
| PATCH  | /api/staff/{id}        | 🔒 `staff.manage` | Partial staff fields                                               | Updated staff — role/password/disable change revokes sessions; protected admins and last-active-admin removal → 403 |
| DELETE | /api/staff/{id}        | 🔒 `staff.manage` | —                                                                  | Soft-disabled staff (isEnabled=false); revokes sessions; protected/last active admin → 403                          |

> **Session revocation.** Changing a staff member's role (group), password, or
> `isEnabled=false` — and changing a group's permission set — revokes that
> member's refresh tokens and sets a per-staff access-token cutoff, so existing
> sessions can no longer act with stale rights (access tokens are rejected
> immediately; refresh is blocked durably).

---

## Users

| Method | Path                                     | Auth             | Body                                           | Returns                           |
| ------ | ---------------------------------------- | ---------------- | ---------------------------------------------- | --------------------------------- |
| GET    | /api/users                               | 🔒 `user.manage` | — (query: search, organizationId, page, limit) | `User[]`                          |
| GET    | /api/users/{id}                          | 🔒 `user.manage` | —                                              | `User` with emails                |
| POST   | /api/users                               | 🔒 `user.manage` | `{fullName, primaryEmail, organizationId?}`    | Created user                      |
| PATCH  | /api/users/{id}                          | 🔒 `user.manage` | Partial user fields                            | Updated user                      |
| POST   | /api/users/{id}/emails                   | 🔒 `user.manage` | `{email: string}`                              | Created user email                |
| DELETE | /api/users/{id}/emails/{emailId}         | 🔒 `user.manage` | —                                              | 204 No Content (non-primary only) |
| PUT    | /api/users/{id}/emails/{emailId}/primary | 🔒 `user.manage` | —                                              | 204 No Content                    |

Changing `isEnabled` or the user's email identity (add/remove/set-primary) atomically revokes all
pending client magic links and active `th_client` sessions. Re-enabling a user does not revive
pre-disable links or sessions; the customer must request a new link.

---

## Organizations

| Method | Path                    | Auth            | Body                           | Returns              |
| ------ | ----------------------- | --------------- | ------------------------------ | -------------------- |
| GET    | /api/organizations      | 🔒 `org.manage` | — (query: search, page, limit) | `Organization[]`     |
| GET    | /api/organizations/{id} | 🔒 `org.manage` | —                              | `Organization`       |
| POST   | /api/organizations      | 🔒 `org.manage` | `{name, website?, slaPlanId?}` | Created organization |
| PATCH  | /api/organizations/{id} | 🔒 `org.manage` | Partial org fields             | Updated organization |
| DELETE | /api/organizations/{id} | 🔒 `org.delete` | —                              | 204 No Content       |

---

## Departments

| Method | Path                  | Auth                   | Body                                            | Returns                          |
| ------ | --------------------- | ---------------------- | ----------------------------------------------- | -------------------------------- |
| GET    | /api/departments      | 🔒 `ticket.view`       | —                                               | `Department[]` (flat list)       |
| GET    | /api/departments/tree | 🔒 `ticket.view`       | —                                               | `Department[]` (nested children) |
| GET    | /api/departments/{id} | 🔒 `ticket.view`       | —                                               | `Department`                     |
| POST   | /api/departments      | 🔒 `admin.departments` | `{title, parentId?, isDefault?, displayOrder?}` | Created department               |
| PATCH  | /api/departments/{id} | 🔒 `admin.departments` | Partial department fields                       | Updated department               |
| DELETE | /api/departments/{id} | 🔒 `admin.departments` | —                                               | 204 No Content                   |

---

## Knowledgebase

| Method | Path                            | Auth           | Body                                                    | Returns                                   |
| ------ | ------------------------------- | -------------- | ------------------------------------------------------- | ----------------------------------------- |
| GET    | /api/kb/articles                | 🔓             | — (query: search, categoryId, page, limit)              | Published articles list                   |
| GET    | /api/kb/articles/slug/{slug}    | 🔓             | —                                                       | Published article (increments view count) |
| GET    | /api/kb/categories              | 🔓             | —                                                       | `KbCategory[]`                            |
| GET    | /api/kb/articles/{id}           | 🔒 `kb.view`   | —                                                       | Full article (any status, staff only)     |
| GET    | /api/kb/articles/{id}/revisions | 🔒 `kb.view`   | —                                                       | Revision history for an article           |
| POST   | /api/kb/categories              | 🔒 `kb.manage` | `{title, parentId?, displayOrder?}`                     | Created category                          |
| POST   | /api/kb/articles                | 🔒 `kb.manage` | `{title, slug, contents, categoryId, isPublished?}`     | Created article                           |
| PUT    | /api/kb/articles/{id}           | 🔒 `kb.manage` | `{title?, slug?, contents?, categoryId?, isPublished?}` | Updated article (saves revision)          |

---

## News

| Method | Path           | Auth             | Body                              | Returns                                              |
| ------ | -------------- | ---------------- | --------------------------------- | ---------------------------------------------------- |
| GET    | /api/news      | 🔓               | —                                 | Published news items (ordered by `publishedAt` desc) |
| GET    | /api/news/all  | 🔒 `news.manage` | —                                 | All news items including drafts                      |
| POST   | /api/news      | 🔒 `news.manage` | `{title, contents, isPublished?}` | Created news item                                    |
| PUT    | /api/news/{id} | 🔒 `news.manage` | Partial news fields               | Updated news item                                    |

---

## Alaris

| Method | Path                | Auth                        | Body                                   | Returns                         |
| ------ | ------------------- | --------------------------- | -------------------------------------- | ------------------------------- |
| POST   | /api/alaris/webhook | 🔑 `x-alaris-secret` header | `{externalId, severity, message, ...}` | `{event, ticket, deduplicated}` |

> Note: This route is `@Public()` (bypasses JWT guard) but enforces `x-alaris-secret`
> against `TELECOM_HD_ALARIS_WEBHOOK_SECRET`. Deduplicates by `externalId`; auto-creates
> a ticket via `TicketsService.createTicket()` with `creationMode: 'ALARIS'`.

---

## Inbound mail

| Method | Path              | Auth                         | Body             | Returns              |
| ------ | ----------------- | ---------------------------- | ---------------- | -------------------- |
| POST   | /api/inbound/pipe | 🔑 `x-inbound-secret` header | `{ raw: string}` | `{ accepted: true }` |

> Note: `@Public()` (bypasses JWT) but enforces `x-inbound-secret` against
> `TELECOM_HD_INBOUND_WEBHOOK_SECRET` (constant-time). `raw` is the full RFC822
> message; it feeds the same parse→thread→dedup→ticket pipeline as the IMAP poller
> (`InboundMailService.ingestRawMessage`). For MTA/PIPE delivery (Postfix/Exim pipe
> transport). Loop-guarded (Auto-Submitted / Precedence / X-Loop / self-from) and
> deduplicated by `Message-ID`. Returns `202 Accepted`.
> Optional `x-inbound-delivery-id` header — an explicit idempotency key recorded on the
> `InboundDelivery` ledger; without it the message is de-duplicated by content hash, so a
> retry of the identical body never creates a second ticket.

---

## Reports

| Method | Path                   | Auth                | Body                                   | Returns                                       |
| ------ | ---------------------- | ------------------- | -------------------------------------- | --------------------------------------------- |
| GET    | /api/reports/dashboard | 🔒 `ticket.view`    | —                                      | `{total, resolved, byStatus[], byPriority[]}` |
| GET    | /api/reports           | 🔒 `ticket.view`    | —                                      | `Report[]`                                    |
| GET    | /api/reports/{id}/run  | 🔒 `ticket.view`    | —                                      | aggregated rows for stored report             |
| POST   | /api/reports           | 🔒 `admin.settings` | `{title, kind, definition}` (KQL-lite) | Created report                                |

## Troubleshooter

| Method | Path                                      | Auth           | Body                                           | Returns                            |
| ------ | ----------------------------------------- | -------------- | ---------------------------------------------- | ---------------------------------- |
| GET    | /api/troubleshooter/categories            | 🔓             | —                                              | `TroubleshooterCategory[]`         |
| GET    | /api/troubleshooter/categories/{id}/steps | 🔓             | —                                              | step tree (steps + outgoing links) |
| POST   | /api/troubleshooter/categories            | 🔒 `kb.manage` | `{title, parentId?, displayOrder?}`            | Created category                   |
| POST   | /api/troubleshooter/steps                 | 🔒 `kb.manage` | `{categoryId, title, contents, displayOrder?}` | Created step                       |
| POST   | /api/troubleshooter/links                 | 🔒 `kb.manage` | `{fromId, toId, label?}`                       | Created step link                  |

---

## SLA Admin

SLA plans, schedules, holidays, and escalation rules. All routes require `admin.sla` permission.

### SLA Plans

| Method | Path                      | Auth           | Body                                                                                     | Returns                                |
| ------ | ------------------------- | -------------- | ---------------------------------------------------------------------------------------- | -------------------------------------- |
| GET    | /api/admin/sla/plans      | 🔒 `admin.sla` | —                                                                                        | `SlaPlan[]` (includes escalationRules) |
| POST   | /api/admin/sla/plans      | 🔒 `admin.sla` | `{title, isEnabled?, firstResponseSeconds?, resolutionSeconds?, scheduleId?, criteria?}` | Created plan                           |
| GET    | /api/admin/sla/plans/{id} | 🔒 `admin.sla` | —                                                                                        | `SlaPlan` with escalationRules         |
| PUT    | /api/admin/sla/plans/{id} | 🔒 `admin.sla` | Partial plan fields                                                                      | Updated plan                           |
| DELETE | /api/admin/sla/plans/{id} | 🔒 `admin.sla` | —                                                                                        | 204 No Content                         |

### SLA Escalation Rules (nested under plan)

| Method | Path                                                | Auth           | Body                                                        | Returns            |
| ------ | --------------------------------------------------- | -------------- | ----------------------------------------------------------- | ------------------ |
| GET    | /api/admin/sla/plans/{planId}/escalation-rules      | 🔒 `admin.sla` | —                                                           | `EscalationRule[]` |
| POST   | /api/admin/sla/plans/{planId}/escalation-rules      | 🔒 `admin.sla` | `{name, targetType, thresholdSeconds, actions, isEnabled?}` | Created rule       |
| PUT    | /api/admin/sla/plans/{planId}/escalation-rules/{id} | 🔒 `admin.sla` | Partial rule fields                                         | Updated rule       |
| DELETE | /api/admin/sla/plans/{planId}/escalation-rules/{id} | 🔒 `admin.sla` | —                                                           | 204 No Content     |

> `actions` is a JSON array of `{ type: 'notify' | 'change_priority' | 'assign' | 'add_note' | 'mark_escalated', staffId?, priorityId?, note? }`.

### SLA Schedules

| Method | Path                          | Auth           | Body                           | Returns                             |
| ------ | ----------------------------- | -------------- | ------------------------------ | ----------------------------------- |
| GET    | /api/admin/sla/schedules      | 🔒 `admin.sla` | —                              | `SlaSchedule[]` (includes holidays) |
| POST   | /api/admin/sla/schedules      | 🔒 `admin.sla` | `{title, timezone, workHours}` | Created schedule                    |
| GET    | /api/admin/sla/schedules/{id} | 🔒 `admin.sla` | —                              | `SlaSchedule` with holidays         |
| PUT    | /api/admin/sla/schedules/{id} | 🔒 `admin.sla` | Partial schedule fields        | Updated schedule                    |
| DELETE | /api/admin/sla/schedules/{id} | 🔒 `admin.sla` | —                              | 204 No Content                      |

> `workHours` is a JSON object keyed by day abbreviation (mon–sun) with arrays of `["HH:MM", "HH:MM"]` slot pairs.

### SLA Holidays (nested under schedule)

| Method | Path                                                | Auth           | Body                   | Returns         |
| ------ | --------------------------------------------------- | -------------- | ---------------------- | --------------- |
| GET    | /api/admin/sla/schedules/{scheduleId}/holidays      | 🔒 `admin.sla` | —                      | `SlaHoliday[]`  |
| POST   | /api/admin/sla/schedules/{scheduleId}/holidays      | 🔒 `admin.sla` | `{date, title?}`       | Created holiday |
| PUT    | /api/admin/sla/schedules/{scheduleId}/holidays/{id} | 🔒 `admin.sla` | Partial holiday fields | Updated holiday |
| DELETE | /api/admin/sla/schedules/{scheduleId}/holidays/{id} | 🔒 `admin.sla` | —                      | 204 No Content  |

---

## Workflows & Macros

### Workflows

| Method | Path                      | Auth                | Body                                                 | Returns                             |
| ------ | ------------------------- | ------------------- | ---------------------------------------------------- | ----------------------------------- |
| GET    | /api/admin/workflows      | 🔒 `admin.workflow` | —                                                    | `Workflow[]` (ordered by sortOrder) |
| POST   | /api/admin/workflows      | 🔒 `admin.workflow` | `{title, criteria, actions, isEnabled?, sortOrder?}` | Created workflow                    |
| GET    | /api/admin/workflows/{id} | 🔒 `admin.workflow` | —                                                    | `Workflow`                          |
| PUT    | /api/admin/workflows/{id} | 🔒 `admin.workflow` | Partial workflow fields                              | Updated workflow                    |
| DELETE | /api/admin/workflows/{id} | 🔒 `admin.workflow` | —                                                    | 204 No Content                      |

> `criteria` is a JSON array of `{ field, op: 'eq'|'neq'|'contains'|'gt'|'lt', value }`.
> `actions` is a JSON array of `{ type: 'change_department'|'change_owner'|'change_status'|'change_priority'|'change_type'|'add_tag'|'add_note', ...params }`.

### Macros

| Method | Path                   | Auth                | Body                                         | Returns                       |
| ------ | ---------------------- | ------------------- | -------------------------------------------- | ----------------------------- |
| GET    | /api/admin/macros      | 🔒 `admin.workflow` | — (query: `categoryId?`)                     | `Macro[]` (includes category) |
| POST   | /api/admin/macros      | 🔒 `admin.workflow` | `{title, replyText?, actions?, categoryId?}` | Created macro                 |
| GET    | /api/admin/macros/{id} | 🔒 `admin.workflow` | —                                            | `Macro`                       |
| PUT    | /api/admin/macros/{id} | 🔒 `admin.workflow` | Partial macro fields                         | Updated macro                 |
| DELETE | /api/admin/macros/{id} | 🔒 `admin.workflow` | —                                            | 204 No Content                |

### Macro Categories

| Method | Path                             | Auth                | Body                    | Returns                             |
| ------ | -------------------------------- | ------------------- | ----------------------- | ----------------------------------- |
| GET    | /api/admin/macro-categories      | 🔒 `admin.workflow` | —                       | `MacroCategory[]` (includes macros) |
| POST   | /api/admin/macro-categories      | 🔒 `admin.workflow` | `{title, parentId?}`    | Created category                    |
| GET    | /api/admin/macro-categories/{id} | 🔒 `admin.workflow` | —                       | `MacroCategory` with macros         |
| PUT    | /api/admin/macro-categories/{id} | 🔒 `admin.workflow` | Partial category fields | Updated category                    |
| DELETE | /api/admin/macro-categories/{id} | 🔒 `admin.workflow` | —                       | 204 No Content                      |

---

## Admin / Custom Fields

| Method | Path                                            | Auth                    | Body                                                                          | Returns                                                         |
| ------ | ----------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | ------- | ------------------------------- | ------------- |
| GET    | /api/admin/custom-field-groups                  | 🔒 `admin.customfields` | —                                                                             | `CustomFieldGroup[]` (includes fields, ordered by displayOrder) |
| POST   | /api/admin/custom-field-groups                  | 🔒 `admin.customfields` | `{title, scope: 'TICKET'                                                      | 'USER'                                                          | 'STAFF' | 'ORGANIZATION', displayOrder?}` | Created group |
| PATCH  | /api/admin/custom-field-groups/{id}             | 🔒 `admin.customfields` | Partial group fields                                                          | Updated group                                                   |
| DELETE | /api/admin/custom-field-groups/{id}             | 🔒 `admin.customfields` | —                                                                             | 204 No Content                                                  |
| POST   | /api/admin/custom-field-groups/{groupId}/fields | 🔒 `admin.customfields` | `{fieldKey, title, type, isRequired?, isEncrypted?, options?, displayOrder?}` | Created field                                                   |
| PATCH  | /api/admin/custom-fields/{id}                   | 🔒 `admin.customfields` | Partial field fields (fieldKey immutable)                                     | Updated field                                                   |
| DELETE | /api/admin/custom-fields/{id}                   | 🔒 `admin.customfields` | —                                                                             | 204 No Content                                                  |

> `type` enum: `TEXT | TEXTAREA | PASSWORD | CHECKBOX | RADIO | SELECT | MULTISELECT | DATE | FILE | CUSTOM`.

---

## Admin / Email Templates

| Method | Path                            | Auth            | Body                                           | Returns                                    |
| ------ | ------------------------------- | --------------- | ---------------------------------------------- | ------------------------------------------ |
| GET    | /api/admin/email-templates      | 🔒 `admin.mail` | —                                              | `EmailTemplate[]` (ordered by key, locale) |
| POST   | /api/admin/email-templates      | 🔒 `admin.mail` | `{key, locale?, subject, htmlBody, textBody?}` | Created template                           |
| PATCH  | /api/admin/email-templates/{id} | 🔒 `admin.mail` | Partial template fields (key/locale immutable) | Updated template                           |
| DELETE | /api/admin/email-templates/{id} | 🔒 `admin.mail` | —                                              | 204 No Content                             |

---

## Admin / Email Queues + inbound ledger

| Method | Path                                                           | Auth            | Body                                                                                         | Returns                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | /api/admin/email-queues                                        | 🔒 `admin.mail` | —                                                                                            | `EmailQueue[]` (no password; incl. `syncState`, `lastError`, `lastSeenUid`, `uidValidity`, `cursorGeneration`)                                                                                                                                                                                                                                                              |
| GET    | /api/admin/email-queues/{id}                                   | 🔒 `admin.mail` | —                                                                                            | Queue (with sync health)                                                                                                                                                                                                                                                                                                                                                    |
| POST   | /api/admin/email-queues                                        | 🔒 `admin.mail` | queue fields                                                                                 | Created queue                                                                                                                                                                                                                                                                                                                                                               |
| PUT    | /api/admin/email-queues/{id}                                   | 🔒 `admin.mail` | partial                                                                                      | Updated queue                                                                                                                                                                                                                                                                                                                                                               |
| DELETE | /api/admin/email-queues/{id}                                   | 🔒 `admin.mail` | —                                                                                            | 204 No Content                                                                                                                                                                                                                                                                                                                                                              |
| POST   | /api/admin/email-queues/{id}/reconcile                         | 🔒 `admin.mail` | `{ mode: 'RESUME_MIGRATED' \| 'FROM_NOW' \| 'BACKFILL', reason?, confirm?, backfillLimit? }` | Cutover off the legacy Setting cursor. `RESUME_MIGRATED` carries `imap/state:<id>` (UIDVALIDITY+watermark, rewound past pending UIDs) forward; `FROM_NOW` (requires `confirm:true`+`reason`) discards it; `BACKFILL` re-bootstraps with `backfillLimit`. Bumps `cursorGeneration`; audits before/after cursor + mode + actor. Returns `{ reconciled, mode, queue, detail }` |
| GET    | /api/admin/email-queues/inbound/quarantine                     | 🔒 `admin.mail` | —                                                                                            | Quarantined `InboundDelivery[]` (metadata only)                                                                                                                                                                                                                                                                                                                             |
| POST   | /api/admin/email-queues/inbound/quarantine/{deliveryId}/replay | 🔒 `admin.mail` | —                                                                                            | `{ replayed: true }` — resets the delivery to ACCEPTED so the drain reprocesses it                                                                                                                                                                                                                                                                                          |
