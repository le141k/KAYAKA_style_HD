# UI/UX Audit — 20-Agent Full Sweep (commander's consolidation)

**Date:** 2026-05-24
**Method:** 18 static deep-audits (every button/link/modal/form → handler → API endpoint) + 2 LIVE Playwright simulations against the running stack (web :3000, api :4000). Logins: admin@23telecom.example / agent@23telecom.example (demo1234).

---

## TL;DR

**Core ticket lifecycle works end-to-end (live-verified).** Agent #19 drove a real ticket through submit → find → assign → all 5 status transitions → public reply → internal note → macro apply → priority/department change → tag add/remove → spawn-supplier → merge → split, with persistence confirmed after each step. The client submit/list/reply and KB browse flows are wired to real endpoints.

**The gaps are concentrated in (a) the ADMIN panel — many features have a complete API but missing/incomplete UI — and (b) error-handling polish (optimistic updates without rollback, swallowed errors).** Several are data-loss or "feature silently does nothing" class.

---

## BLOCKER / CRITICAL

| #   | Area                | Finding                                                                                                                                                                                                    | Location                                                   |
| --- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| U1  | Staff reply         | **Internal-note attachments silently dropped + lost.** Note branch omits `attachmentIds`; `addNote()` takes no attachments; `Attachment` has no `noteId` FK. Files orphaned on every note-with-attachment. | `use-tickets.ts:377`, `tickets.service.ts addNote`, schema |
| U2  | Admin SLA           | **Schedule work-hours editor missing** → `workHours` always `{}` → SLA breach calc is calendar-blind (every minute treated off-hours / effectively 24/7). Feature non-functional.                          | `sla-content.tsx:57`                                       |
| U3  | Admin SLA           | **Escalation actions builder missing** → rules save with `actions:[]` → escalations fire but do nothing (no notify/assign/note).                                                                           | `sla-content.tsx:72,296`                                   |
| U4  | Admin custom-fields | **SELECT/RADIO/MULTISELECT have no options input** → choice fields created with zero options → unusable. Also **no EDIT button** for fields or groups (create+delete only).                                | `custom-fields-content.tsx:33,110`                         |
| U5  | Admin Alaris/mail   | **Alaris page is a dead stub** (disabled inputs, no API). **Email-queues (IMAP) and parser-rules have full CRUD APIs but ZERO UI** (no page/route/hook/nav tab).                                           | `admin/alaris/page.tsx`, mail controllers                  |
| U6  | Staff ticket        | **Merge / Split / Watchers / CC-BCC: full API, NO UI** — first-class ops unreachable from the app (live sim reached them only via raw API).                                                                | `tickets.controller.ts` vs web                             |
| U7  | Staff ticket        | **Change Type control entirely missing** (API `PATCH /tickets/:id/type` + `/ticket-types` exist, no picker).                                                                                               | `ticket-detail-content.tsx`                                |
| U8  | Admin types         | **Ticket Types: full API + DB, zero admin UI** — operators can't manage them at all.                                                                                                                       | `reference.controller.ts` vs web                           |
| U9  | Admin staff         | **No group management UI** (create/rename/permissions editor all missing) despite page title; **no disable button** on rows; **`DELETE /staff/groups/:id` not even implemented in API**.                   | `staff-content.tsx`, staff.controller                      |
| U10 | Client submit       | **Remove-file (X) button lacks `type="button"`** → clicking it submits the whole form instead of removing the file.                                                                                        | `FileUploadZone.tsx:255`                                   |

---

## HIGH

- **Admin macros: `replyText` field absent** from the macro dialog (DTO+DB support it) → every macro has empty reply body; the headline Kayako macro feature is unconfigurable. `workflows-content.tsx`
- **Admin workflows/macros: criteria & action values are raw free-text ID inputs** (type a numeric status/staff/dept ID by hand; typo silently saves a no-op rule). No pickers despite hooks being available. `workflows-content.tsx:586,628`
- **Admin workflows: `sortOrder` not editable** → all rules at order 0 → execution order undefined.
- **Kanban: no optimistic-rollback on failed move + no `onDragEnd` (phantom drag) + no touch support** → corrupt board state on any failed API call/off-target drop; unusable on mobile. `KanbanBoard.tsx`
- **Reply/note submit errors swallowed** (no try/catch, no toast); **assignee & department changes have no rollback** on error (picker desyncs from server). `ticket-detail-content.tsx`
- **Tag add clears the input before the request resolves** + add/remove failures are silent. `ticket-detail-content.tsx:558`
- **Client ticket thread: post attachments never rendered** + **no attachment upload on client replies** (API supports both). `client-ticket-detail.tsx`, `use-client-tickets.ts:82`
- **Forgot-password is a dead `href="#"`** — no reset page/route/endpoint exists at all. `LoginScreen.tsx:264`
- **Dashboard: recent-tickets error silently shown as empty** (no `isError`); **stat `groupBy` overcounts merged tickets** so card counts contradict the drill-down list. `dashboard-content.tsx:16`, `reports.service.ts:130`
- **Admin departments: create/edit modal missing `type`/`isDefault`/`displayOrder`** → can't make a PRIVATE or default department; **delete of in-use dept → unhandled 500** (raw P2003). `departments-content.tsx`
- **Admin statuses: `isDefault` not settable from UI**; delete-in-use shows opaque generic error.

---

## MEDIUM / LOW (selected)

- Admin macro category **rename has no UI** (API `PUT` exists); macro/category edit value-extraction is fragile.
- React-Query cache bug: **custom-field delete doesn't re-render** without a page reload (live-confirmed). `use-admin.ts`
- `register('body')` shared across reply/note tabs (both mounted) → latent RHF ref bug; no char counter.
- Command palette fires a search **per keystroke (no debounce)**; `/admin` links shown to non-admin agents (bounce-redirect UX).
- Date-range filter **not counted in the filter badge** and **not cleared by "reset filters"**.
- Public reply to a **closed** ticket isn't blocked server-side (UI hides it, but the API would reopen it).
- Locale switch **not persisted**; several `aria-label`s hardcoded Russian; KB search no debounce; KB article author always placeholder.
- `/staff/settings` is an **empty ghost directory**; NotificationBell is dead (mock, unmounted).
- Spawn-supplier form drops the optional `subject`/`supplierName` the API accepts.
- Dashboard skeleton renders 4 cards vs 5 real (layout shift); sparklines are fabricated random data.
- Client "Войти" button routes to the **staff** login.
- Delete confirmations use native `window.confirm()` instead of the design-system dialog (departments, statuses, categories).

---

## What works (verified live)

- **Ticket lifecycle**: submit, assign, all status moves, public reply, internal note (text), macro apply, priority/department change, tag add/remove, spawn-supplier, merge, split — all PASS + persisted (agent #19).
- **Admin CRUD scaffolding**: create/edit/delete with confirm dialogs for departments, SLA plans/schedules, statuses, workflows, macros, categories, custom-field groups/fields — all reach correct endpoints (agent #20).
- Client submit (all 5 public endpoints live), client ticket list + email lookup, client reply, KB search/article render, staff login/logout/auth-guard, staff ticket list (filters/saved-views/bulk/pagination/create dialog), dashboard stats.

---

## Recommended fix order

1. **Data-loss / silently-broken**: U1 (note attachments), U2 (SLA work-hours), U3 (escalation actions), U4 (select options) — these lose data or make a configured feature do nothing.
2. **Missing-UI for shipped APIs**: U6 (merge/split/watchers), U7 (change type), U8 (ticket types), U5 (email-queues/parser-rules/Alaris), U9 (staff groups), macro `replyText`.
3. **Error-handling polish**: kanban rollback+touch, reply/assign/dept rollback+toasts, dashboard silent error.
4. **UX correctness**: U10 (remove-file button), forgot-password, client attachments, ID pickers in workflow/macro builders, filter badge/reset.
