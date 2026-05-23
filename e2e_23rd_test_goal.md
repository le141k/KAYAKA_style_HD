# E2E TEST REPORT & /goal WORKLIST — 23 Telecom Help Desk

**Date:** 2026-05-23 · **Target:** live Docker stack (web :3000, API :4000, postgres/redis/mailhog) — all 5 containers up.
**Method:** 15 parallel read-only analysis agents (one per module) derived scenario checklists from code + cross-referenced `docs/QA_AUDIT_REPORT.md` / `FIX_PLAN.md` / `NEXT_GOAL.md`; the coordinator then **executed** the high-impact paths against the live stack via Chromium (Playwright) + the project's existing e2e suite + direct API probes.

> Confidence tags: **[LIVE]** = empirically executed/observed this session · **[CODE]** = predicted from code reading (file:line), not individually run live · **[API]** = confirmed via direct API call.
> Discipline for the /goal pass: fix in priority order → unit/integration test → `tsc`/`lint`/`vitest` green → `docker compose build --no-cache web api && up -d --force-recreate` → re-run the scenario in this doc → commit. Login throttle is **5/60s** — reuse one session when scripting.

---

## 0. Executive summary

The product **runs and the core paths work** — login, the staff workspace, dashboards, admin pages, KB, and the public portal all load and function on the live stack. This is a solid MVP. But it is **not 18/18 green and not production-ready**, and several "done/verified" claims in the docs do not hold up under live execution.

**Headline empirical results:**

- ✅ **Login → `/staff/dashboard` works** for both admin and agent (the scariest agent prediction — a redirect loop — did NOT reproduce). **[LIVE]**
- ✅ **Auth is cookie-only**: no JWT in `localStorage`, only a non-sensitive `th_authed=1` marker; real tokens in HttpOnly cookies. (This **corrects** an earlier static-analysis claim that tokens were dual-stored / XSS-exposed — they are not, in the running build.) **[LIVE]**
- ❌ **Playwright suite is 13/18, not "18/18"** — 5 failing (kanban ×4, ticket-submit ×1). **[LIVE]**
- ❌ **Sub-department creation is impossible via the admin UI** — the "create department" dialog has only a title field, no parent selector (contradicts the NEXT_GOAL "done" claim). **[LIVE]**
- ✅ No console/hydration (#418) errors observed across a full admin session. **[LIVE]**

---

## 1. Empirically verified this session (ground truth)

| #   | Check                                          | Result                                                                   | Evidence                                                                      |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 1   | Admin login → landing                          | ✅ PASS → `/staff/dashboard`                                             | [LIVE] body shows "Admin Telecom", "Открытые заявки 8"                        |
| 2   | Agent login → landing                          | ✅ PASS → `/staff/dashboard`                                             | [LIVE] display name "Alex Ivanov" (DK-12 ok)                                  |
| 3   | Token storage after login                      | ✅ cookie-only (`auth_token` absent in localStorage; `th_authed=1` only) | [LIVE] `api.ts:16-27` cookie-only; HttpOnly `th_access`/`th_refresh` from API |
| 4   | Login brute-force throttle                     | ✅ 429 after 5/60s                                                       | [API] integration logs `x-ratelimit-limit:5`; `auth.controller.ts:83`         |
| 5   | Dashboard metrics render                       | ✅ real (open=8, pending=0, resolved-today=0)                            | [LIVE] `reports.service.ts` `$queryRaw`/count                                 |
| 6   | Notification bell                              | ✅ opens → "Нет уведомлений" (empty **mock**, no crash)                  | [LIVE] `NotificationBell.tsx:20` `MOCK_NOTIFICATIONS=[]`                      |
| 7   | Console / hydration errors                     | ✅ none across dashboard/departments/custom-fields                       | [LIVE] React #418 not reproduced                                              |
| 8   | Public `/submit` renders required custom field | ✅ `amount` input present (8 form fields)                                | [LIVE] human can fill it                                                      |
| 9   | **Admin "create department" dialog**           | ❌ **no parent selector** (1 input: title only)                          | [LIVE] dialog text: "Новый отдел / Название / Отмена / Сохранить"             |
| 10  | **Playwright e2e (live stack, chromium)**      | ❌ **13 passed / 5 failed**                                              | [LIVE] `/tmp/pw.log`                                                          |
| 11  | Public submit via API w/o customFields         | ❌ `400 "Custom field amount is required"`                               | [API] required field enforced; **invisible in admin CF UI**                   |
| 12  | API typecheck / web typecheck                  | ✅ both exit 0                                                           | earlier in session                                                            |
| 13  | API unit tests (vitest)                        | ✅ 447/447                                                               | earlier                                                                       |
| 14  | Integration (Testcontainers)                   | ✅ 7/7                                                                   | earlier                                                                       |

**Playwright failures (test 10):**

- `kanban.spec.ts` ×4 — specs look for the old `role="list"` columns / `TT-XXXXXX` cards; the **native-DnD rewrite changed the DOM** so the specs are stale. (Board itself renders — this is broken _tests_, not necessarily broken feature.)
- `ticket-submit.spec.ts:23` ×1 — success screen never appears because a **required custom field `amount` is not filled** by the test (see test 11). Root cause = **DB test-pollution**, not a clean-deploy regression (the seed creates no `amount` field).

---

## 2. P0 — blockers / false "done" claims (fix first)

- **[P0-A] Playwright suite is red (13/18).** `apps/web/e2e/kanban.spec.ts` (all 4) assert `getByRole("list", {name:/Колонка/})` + `TT-\d{6}` that no longer exist after the native-DnD rewrite; `ticket-submit.spec.ts:23` doesn't fill required custom fields. **[LIVE]** **Fix:** update kanban specs to the current DOM (`<div aria-label="Колонка …">`, `KanbanBoard.tsx:116`); make ticket-submit fill TICKET-scope required CFs or run against a clean seed. Update the docs that claim "18/18".

- **[P0-B] Sub-department creation impossible via UI.** Create/edit dialog renders only the title input — no `parentId` `<select>`/combobox. **[LIVE]** `apps/web/app/(admin)/admin/departments/departments-content.tsx:163-179`. The hook + DTO support `parentId`, only the control is missing. (NEXT_GOAL addendum claims this is verified — it is not.) **Fix:** add a parent-department `<Select>` (options from `GET /departments/tree`).

- **[P0-C] A required custom field can silently break the public portal & is unmanageable.** API enforces required TICKET custom fields on `POST /tickets/public` (returns `400 "Custom field amount is required"`), but that field is **not visible in the admin custom-fields page** (shows other groups as "0 полей"). **[API]+[LIVE]** On this stack it's QA-created pollution, but the pattern is real: any admin-marked-required TICKET field with a display/count bug becomes an invisible submit-blocker. **Fix:** (1) reseed/clean the polluted `amount` field; (2) fix the custom-fields group→fields display so required fields are always visible/removable (`use-admin.ts` group `fields[]` mapping, ties to QA P0-8).

- **[P0-D] Deployment config is dev-only (carried from prod-readiness audit).** `docker-compose.yml` runs `NODE_ENV=development` (→ cookies `secure:false`, dev logging), **re-seeds demo admin `demo1234` on every boot**, bakes `NEXT_PUBLIC_API_URL=http://localhost:4000`, no TLS/restart/secret-mgmt. **[LIVE/CODE]** **Fix:** separate prod compose/env; seed only when empty; real secrets (config validation is length-only `min(32)`, placeholders pass).

---

## 3. P1 — feature claimed but broken / risky

**Tickets & portal**

- **[P1] Priority silently dropped on public submit.** `PublicCreateTicketSchema` has no `priorityId`; Zod strips the UI-sent value. Every public ticket gets default priority. **[CODE]** `apps/api/src/modules/tickets/dto.ts:123-132`; `submit-form.tsx:102`.
- **[P1] Client cannot reply to a resolved ticket → reopen path is dead from the UI.** Reply form hidden when `status==='resolved'`, so the `publicReply` reopen logic is unreachable. **[CODE]** `client-ticket-detail.tsx:109`; reopen at `tickets.service.ts:377-396`.
- **[P1] Client reply has no error handling.** `mutateAsync` without try/catch → unhandled rejection (e.g. 404 when `requesterEmail` empty). **[CODE]** `client-ticket-detail.tsx:45-48`.
- **[P1] "My tickets" cache keyed to empty email** → list can show empty after navigation until reload. **[CODE]** `use-client-tickets.ts:157`.
- **[P1] Ticket management panel hidden below 1280px** (`hidden xl:block`) — no status/priority/assignee/tags on tablet/mobile. **[CODE]** `ticket-detail-content.tsx:329`.

**Staff workspace**

- **[P1] Assignee filter + macro picker empty for non-admin agents.** `useStaffOptions`/`useMacroOptions` call `GET /staff` & `GET /admin/macros` which require `STAFF_MANAGE`/admin perms → 403 for agents; dropdowns silently empty. **[CODE]** `use-tickets.ts:513-525, 443-449`.
- **[P1] SLA-breach stat-card filter is client-side only** (no `slaBreached` server param) → wrong counts across pages. **[CODE]** `use-tickets.ts:251-254`; `dto.ts:86-107`.
- **[P1] Silent MOCK fallback hides API failures.** `useDashboardStats`/`useTickets`/`useKB*` `catch` → return mock data with no error state; a 500/expired token shows fake content. **[CODE]** `use-tickets.ts:554-555`, `use-kb.ts:64,84`.

**Admin**

- **[P1] Macro `isShared` is phantom** — no Prisma column, not in DTO/service; checkbox value lost on every reload. **[CODE]** `prisma/schema.prisma:535-544`, `workflow/dto.ts:30-39` (QA WF-6 "done" — not fixed).
- **[P1] Macro `replyText` + action builder absent in UI** → macros created via UI always have empty reply/actions (the only functional parts). **[CODE]** `workflows-content.tsx:54-59`.
- **[P1] Workflow `send_email` action is a no-op** (logged warning only) though offered in the UI dropdown. **[CODE]** `workflow.executor.ts:163-165`.
- **[P1] Workflow/macro `set_status` from UI may not fire** — `applyMacro` reads `action.statusId` (int key) but UI stores `{type,value:'3'}` (string); no fallback. **[CODE]** `tickets.service.ts:1072-1074`.

**KB & security**

- **[P1] KB article body unstyled** — `prose` class is a no-op because `@tailwindcss/typography` is not installed. **[CODE]** `kb-article-content.tsx:66`; absent from `apps/web/package.json` + `tailwind.config.ts`.
- **[P1-SEC] Staff `getTicket`/`getTicketByMask` leak `user.passwordHash`** via `user:{include:{emails:true}}` returning the raw Prisma object (portal users have an optional passwordHash). **[CODE]** `tickets.service.ts:472,505`. (Public endpoints are correctly narrowed; staff ones are not.) **Fix:** narrow `select` like `PUBLIC_USER_SELECT`.
- **[P1-SEC] No per-endpoint rate limit on `POST /tickets/public`** (only global 300/60s) → ticket spam/DoS. **[CODE]** `tickets.controller.ts:63-77` (`// TODO: rate-limit` — QA AU-2 marked done, not done).

---

## 4. P2 / P3 — polish & latent issues

- i18n switch is a no-op and not persisted (locale in `useState("ru")`; nav labels hardcoded RU). `providers.tsx:30`, `SidebarNav.tsx:26-30`. **[CODE]**
- "Resolved today" stat card not clickable (others are). `dashboard-content.tsx:55-59`. **[CODE]**
- "Профиль" menu item points to `/admin/staff`, not a user profile. `staff/layout.tsx:141`. **[CODE]**
- Custom-field type badge likely shows raw UPPERCASE (`NUMBER`) — **unverified** (no visible fields on the polluted stack to check). `custom-fields-content.tsx:106`. **[CODE]**
- Kanban: `onDragLeave` flicker; no optimistic-rollback on PATCH failure; 50-card cap (no pagination); skeleton shows 4 cols vs 5. `KanbanBoard.tsx:100,160-171`; `kanban-content.tsx:11`. **[CODE]**
- Duplicate `id="reply-textarea"` on both reply/note tabs (hotkey/label target the wrong one). `ticket-detail-content.tsx:287,296`. **[CODE]**
- Department tree only nests 2 levels. `departments.service.ts:16`. **[CODE]**
- Admin CRUD `catch {}` swallows API 400/409 `issues[]` detail → generic toasts everywhere (QA S6). **[CODE]**
- Radix `DialogContent` missing `DialogDescription`/`aria-describedby` across ~9 admin dialogs → a11y console warnings. **[CODE]**
- KB category "N статей" counter includes drafts (latent; ok only while all articles published). `knowledgebase.service.ts:33`. **[CODE]**
- Middleware is presence-only (no role check) → an agent can briefly SSR `/admin/*` before the client redirect (API still enforces perms). `middleware.ts:22`. **[CODE]**
- Attachment progress bar is cosmetic (0→100 in one tick); oversized files dropped silently; attachments dropped for internal notes. `FileUploadZone.tsx:92,112`; `use-tickets.ts:369-370`. **[CODE]**

---

## 5. Test-suite & environment health

- **Playwright 13/18** (chromium, live stack). Fix the 4 kanban specs + 1 submit spec (§2 P0-A). Mobile-chrome project not run.
- **Stale specs**: `kanban.spec.ts` written for the old Framer `Reorder.Group`; rewrite for native DnD DOM.
- **DB pollution**: a QA-created required custom field `amount` (not in seed) blocks API public-submit and is invisible in the admin UI. **Reseed before any clean E2E run** (`docker compose down -v && up`).
- **Working tree was unstable during testing** — files (e.g. `api.ts`, the `RelativeTime` set) changed between reads; run clean E2E off a committed, rebuilt image, not the live working tree.
- Confirmed-good (do not re-touch): login throttle, cookie-only auth, global guards, Prisma exception filter, public-ticket ownership + passwordHash narrow-select, isAdmin escalation block, dashboard real metrics, ticket status/priority/assignee(ownerStaffId)/dept/tags/close wiring, first-post dedup, apply-macro/dept-change endpoints.

---

## 6. Appendix — per-area regression scenarios

The 15 agents produced executable scenario checklists (steps → expected → API → predicted result + file:line). They are the regression script for future passes. Areas covered: **Auth/Login, Client-Submit, Client-MyTickets/Detail, Knowledgebase, Staff-Dashboard, Staff-TicketList, Staff-TicketDetail, Kanban, Staff-Chrome(Notif/⌘K/Nav), Admin-Departments, Admin-Staff, Admin-CustomFields, Admin-SLA, Admin-Workflows/Macros, Attachments/Alaris/Errors.**

Each item above is tagged with its QA-ref (P0-x, TD-x, WF-x, …) so it maps back to `docs/QA_AUDIT_REPORT.md`. For the next `/goal` pass, work §2 → §3 → §5 (fix tests + reseed) → §4, re-running the matching scenario after each fix against a freshly rebuilt image.

```
admin@23telecom.example / demo1234   ·   agent@23telecom.example / demo1234
web http://localhost:3000   ·   api http://localhost:4000/api/docs   ·   mailhog http://localhost:8025
```
