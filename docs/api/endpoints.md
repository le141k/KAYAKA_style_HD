# REST API endpoints — 23 Telecom Help Desk

> Living doc — must mirror the Swagger spec at `/api/docs`. Keep in sync with controllers
> (see `CLAUDE.md` → "Living docs"). _(This index is regenerated from the live OpenAPI spec
> at `http://localhost:4000/api/docs-json` and cross-checked against controllers; do not
> let it drift from actual routes.)_

All routes are under the `/api` global prefix.

**Auth column legend:**
- 🔓 public (no auth)
- 🔑 shared-secret (`x-alaris-secret` header, not JWT)
- 🔒 JWT Bearer + listed permission key

---

## Auth

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | /api/auth/login | 🔓 | `{email, password}` | `{accessToken, refreshToken, staff}` |
| POST | /api/auth/refresh | 🔓 | `{refreshToken}` | `{accessToken, refreshToken}` |
| POST | /api/auth/logout | 🔒 _(any valid JWT)_ | — | 204 No Content |
| GET | /api/auth/me | 🔒 _(any valid JWT)_ | — | Current staff principal |

---

## Tickets

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | /api/tickets/public | 🔓 | `{subject, contents, requesterEmail, requesterName?, departmentId?, customFields?}` | Created ticket |
| GET | /api/tickets | 🔒 `ticket.view` | — (query: statusId, priorityId, departmentId, typeId, userId, ownerStaffId, unassigned, search, page, limit, sortBy, sortDir) | `{data: Ticket[], total: number}` |
| POST | /api/tickets | 🔒 `ticket.create` | `{subject, contents, requesterEmail, requesterName, departmentId, ...}` | Created ticket |
| GET | /api/tickets/{id} | 🔒 `ticket.view` | — | Ticket with posts, notes, watchers, tags, audit log |
| GET | /api/tickets/by-mask/{mask} | 🔒 `ticket.view` | — | Ticket with posts, notes, watchers, tags (e.g. `TT-000042`) |
| POST | /api/tickets/{id}/reply | 🔒 `ticket.reply` | `{contents, isHtml?, isNote?, isEmailed?, isThirdParty?, creationMode?, ipAddress?}` | Created post |
| POST | /api/tickets/{id}/notes | 🔒 `ticket.note` | `{contents, isHtml?}` | Created note (internal only) |
| PATCH | /api/tickets/{id}/assign | 🔒 `ticket.assign` | `{ownerStaffId: number \| null}` | Updated ticket |
| PATCH | /api/tickets/{id}/status | 🔒 `ticket.edit` | `{statusId: number}` | Updated ticket |
| PATCH | /api/tickets/{id}/priority | 🔒 `ticket.edit` | `{priorityId: number}` | Updated ticket |
| PATCH | /api/tickets/{id}/type | 🔒 `ticket.edit` | `{typeId: number \| null}` | Updated ticket |
| POST | /api/tickets/{id}/merge | 🔒 `ticket.merge` | `{targetTicketId: number}` | Target ticket (posts moved, source marked merged) |
| POST | /api/tickets/{id}/watchers | 🔒 `ticket.view` | `{staffId: number}` | 204 No Content |
| DELETE | /api/tickets/{id}/watchers/{staffId} | 🔒 `ticket.view` | — | 204 No Content |
| POST | /api/tickets/{id}/tags | 🔒 `ticket.edit` | `{name: string}` | 204 No Content |
| DELETE | /api/tickets/{id}/tags/{name} | 🔒 `ticket.edit` | — | 204 No Content |

---

## Reference Data (Ticket Statuses, Priorities, Types)

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/ticket-statuses | 🔒 `ticket.view` | — | `TicketStatus[]` |
| POST | /api/ticket-statuses | 🔒 `admin.settings` | `{title, color?, isDefault?, markAsResolved?}` | Created status |
| PATCH | /api/ticket-statuses/{id} | 🔒 `admin.settings` | Partial status fields | Updated status |
| DELETE | /api/ticket-statuses/{id} | 🔒 `admin.settings` | — | 204 No Content |
| GET | /api/ticket-priorities | 🔒 `ticket.view` | — | `TicketPriority[]` |
| POST | /api/ticket-priorities | 🔒 `admin.settings` | `{title, color?, displayOrder?}` | Created priority |
| PATCH | /api/ticket-priorities/{id} | 🔒 `admin.settings` | Partial priority fields | Updated priority |
| DELETE | /api/ticket-priorities/{id} | 🔒 `admin.settings` | — | 204 No Content |
| GET | /api/ticket-types | 🔒 `ticket.view` | — | `TicketType[]` |
| POST | /api/ticket-types | 🔒 `admin.settings` | `{title, displayOrder?}` | Created type |
| PATCH | /api/ticket-types/{id} | 🔒 `admin.settings` | Partial type fields | Updated type |
| DELETE | /api/ticket-types/{id} | 🔒 `admin.settings` | — | 204 No Content |

---

## Staff

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/staff/groups | 🔒 `staff.manage` | — | `StaffGroup[]` |
| GET | /api/staff/groups/{id} | 🔒 `staff.manage` | — | `StaffGroup` |
| POST | /api/staff/groups | 🔒 `staff.manage` | `{title, isAdmin?, permissions?}` | Created group |
| PATCH | /api/staff/groups/{id} | 🔒 `staff.manage` | Partial group fields | Updated group |
| GET | /api/staff | 🔒 `staff.manage` | — (query: search, groupId, page, limit) | `Staff[]` |
| GET | /api/staff/{id} | 🔒 `staff.manage` | — | `Staff` |
| POST | /api/staff | 🔒 `staff.manage` | `{email, firstName, lastName, password, staffGroupId}` | Created staff member |
| PATCH | /api/staff/{id} | 🔒 `staff.manage` | Partial staff fields | Updated staff member |
| DELETE | /api/staff/{id} | 🔒 `staff.manage` | — | Soft-disabled staff (isEnabled=false) |

---

## Users

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/users | 🔒 `user.manage` | — (query: search, organizationId, page, limit) | `User[]` |
| GET | /api/users/{id} | 🔒 `user.manage` | — | `User` with emails |
| POST | /api/users | 🔒 `user.manage` | `{fullName, primaryEmail, organizationId?}` | Created user |
| PATCH | /api/users/{id} | 🔒 `user.manage` | Partial user fields | Updated user |
| POST | /api/users/{id}/emails | 🔒 `user.manage` | `{email: string}` | Created user email |
| DELETE | /api/users/{id}/emails/{emailId} | 🔒 `user.manage` | — | 204 No Content (non-primary only) |
| PUT | /api/users/{id}/emails/{emailId}/primary | 🔒 `user.manage` | — | 204 No Content |

---

## Organizations

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/organizations | 🔒 `org.manage` | — (query: search, page, limit) | `Organization[]` |
| GET | /api/organizations/{id} | 🔒 `org.manage` | — | `Organization` |
| POST | /api/organizations | 🔒 `org.manage` | `{name, website?, slaPlanId?}` | Created organization |
| PATCH | /api/organizations/{id} | 🔒 `org.manage` | Partial org fields | Updated organization |
| DELETE | /api/organizations/{id} | 🔒 `org.manage` | — | 204 No Content |

---

## Departments

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/departments | 🔒 `ticket.view` | — | `Department[]` (flat list) |
| GET | /api/departments/tree | 🔒 `ticket.view` | — | `Department[]` (nested children) |
| GET | /api/departments/{id} | 🔒 `ticket.view` | — | `Department` |
| POST | /api/departments | 🔒 `admin.departments` | `{title, parentId?, isDefault?, displayOrder?}` | Created department |
| PATCH | /api/departments/{id} | 🔒 `admin.departments` | Partial department fields | Updated department |
| DELETE | /api/departments/{id} | 🔒 `admin.departments` | — | 204 No Content |

---

## Knowledgebase

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/kb/articles | 🔓 | — (query: search, categoryId, page, limit) | Published articles list |
| GET | /api/kb/articles/slug/{slug} | 🔓 | — | Published article (increments view count) |
| GET | /api/kb/categories | 🔓 | — | `KbCategory[]` |
| GET | /api/kb/articles/{id} | 🔒 `kb.view` | — | Full article (any status, staff only) |
| GET | /api/kb/articles/{id}/revisions | 🔒 `kb.view` | — | Revision history for an article |
| POST | /api/kb/categories | 🔒 `kb.manage` | `{title, parentId?, displayOrder?}` | Created category |
| POST | /api/kb/articles | 🔒 `kb.manage` | `{title, slug, contents, categoryId, isPublished?}` | Created article |
| PUT | /api/kb/articles/{id} | 🔒 `kb.manage` | `{title?, slug?, contents?, categoryId?, isPublished?}` | Updated article (saves revision) |

---

## News

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/news | 🔓 | — | Published news items (ordered by `publishedAt` desc) |
| GET | /api/news/all | 🔒 `news.manage` | — | All news items including drafts |
| POST | /api/news | 🔒 `news.manage` | `{title, contents, isPublished?}` | Created news item |
| PUT | /api/news/{id} | 🔒 `news.manage` | Partial news fields | Updated news item |

---

## Alaris

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| POST | /api/alaris/webhook | 🔑 `x-alaris-secret` header | `{externalId, severity, message, ...}` | `{event, ticket, deduplicated}` |

> Note: This route is `@Public()` (bypasses JWT guard) but enforces `x-alaris-secret`
> against `TELECOM_HD_ALARIS_WEBHOOK_SECRET`. Deduplicates by `externalId`; auto-creates
> a ticket via `TicketsService.createTicket()` with `creationMode: 'ALARIS'`.

---

## Reports

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/reports/dashboard | 🔒 `ticket.view` | — | `{total, resolved, byStatus[], byPriority[]}` |
| GET | /api/reports | 🔒 `ticket.view` | — | `Report[]` |
| GET | /api/reports/{id}/run | 🔒 `ticket.view` | — | aggregated rows for stored report |
| POST | /api/reports | 🔒 `admin.settings` | `{title, kind, definition}` (KQL-lite) | Created report |

## Troubleshooter

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| GET | /api/troubleshooter/categories | 🔓 | — | `TroubleshooterCategory[]` |
| GET | /api/troubleshooter/categories/{id}/steps | 🔓 | — | step tree (steps + outgoing links) |
| POST | /api/troubleshooter/categories | 🔒 `kb.manage` | `{title, parentId?, displayOrder?}` | Created category |
| POST | /api/troubleshooter/steps | 🔒 `kb.manage` | `{categoryId, title, contents, displayOrder?}` | Created step |
| POST | /api/troubleshooter/links | 🔒 `kb.manage` | `{fromId, toId, label?}` | Created step link |
