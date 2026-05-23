# BUG REPORT — 23 Telecom Help Desk

**Date:** 2026-05-23 · **Build:** live Docker stack (currently-deployed images), **fresh DB** (`docker compose down -v && up -d`).
**Tester:** Claude (coordinator) + 15 analysis agents. **Method:** full A-to-Z run — every interface (client/staff/admin) driven via real Chromium against the live stack + authenticated API probes + the project's Playwright suite. Each defect below was reproduced live unless tagged `[CODE]`.

**Stack URLs:** web `http://localhost:3000` · API `http://localhost:4000/api/docs` · MailHog `http://localhost:8025`
**Demo creds:** `admin@23telecom.example` / `demo1234` · `agent@23telecom.example` / `demo1234`

> Severity: **S1** = blocks core use / data loss / security · **S2** = feature broken or wrong, workaround exists · **S3** = minor/cosmetic/polish.
> Status: **CONFIRMED** = reproduced live this session · **CODE** = located in source, not individually run live · **CORRECTED** = earlier claim disproven by live testing.

---

## Summary

The product is a **working, demo-ready MVP**. Core flows — login, the staff workspace, dashboards, the whole admin CRUD surface, the public portal, and the knowledge base — **function correctly on a clean database.** Most P0 items from the original `docs/QA_AUDIT_REPORT.md` are genuinely fixed.

- **Tested:** ~40 live scenarios across 3 interfaces + 7 security/API probes + 18 Playwright specs.
- **Confirmed defects:** 2 × S2, ~6 × S3 live; ~15 additional S2/S3 located at code level.
- **NOT production-ready** for deployment reasons (dev config), but **functionally sound** for a demo/pilot.
- Two of my own earlier static-analysis claims were **wrong** and are corrected below (see §Corrections) — the working tree was being edited during analysis, so static reads went stale; **live testing is authoritative.**

### Verified WORKING (regression-confirmed, do not "fix")

| Area                                                                                                      | Result                                  |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Login → `/staff/dashboard` (admin + agent)                                                                | ✅ no redirect loop                     |
| Auth = HttpOnly cookies, **no JWT in localStorage**                                                       | ✅ XSS-safe token storage               |
| Login brute-force throttle (5/60s → 429)                                                                  | ✅                                      |
| Dashboard real metrics, **no fake trend badges**                                                          | ✅                                      |
| Ticket list / detail render; status & priority **PATCH persist** (200)                                    | ✅                                      |
| Kanban renders 8 cards across 5 columns                                                                   | ✅                                      |
| **Admin create — departments / staff / custom-field-groups / SLA plans / workflows / statuses all → 201** | ✅ (entire QA P0-4…P0-10 cluster fixed) |
| Client portal: submit, **my-tickets (client_email)**, **public detail**, **public reply**                 | ✅ (QA CL-3/4/5 fixed)                  |
| KB list / search / empty-state / 404                                                                      | ✅                                      |
| **Security:** IDOR→404, isAdmin-escalation blocked, no passwordHash leak, Prisma errors→404/400 (not 500) | ✅                                      |
| Alaris admin "coming-soon" stub                                                                           | ✅ renders, no crash                    |
| No console/hydration (#418) errors in admin session                                                       | ✅                                      |

---

## S2 — confirmed defects (feature broken/wrong, workaround exists)

### BUG-001 — Priority is silently dropped on public ticket submit `[CONFIRMED]`

- **Area:** Client portal `/submit`
- **Steps:** Open `/submit`; fill name/email/subject/description; select priority **"Критический"**; submit.
- **Expected:** Created ticket has urgent priority.
- **Actual:** Ticket is created (201) but with **`priorityId: 1` (default)** — the selected priority is ignored. Verified: created TT-000008 via UI with "Критический" selected → `GET /tickets/my` shows `priorityId:1`.
- **Root cause:** `PublicCreateTicketSchema` has no `priorityId` field → Zod strips it before the service. The form casts it in anyway with no effect.
- **Files:** `apps/api/src/modules/tickets/dto.ts:123-132`; `apps/web/app/(client)/submit/submit-form.tsx:102`.
- **Fix:** add `priorityId` to `PublicCreateTicketSchema` and pass through in the controller.

### BUG-002 — Agents cannot use the assignee dropdown or macro picker on a ticket `[CONFIRMED]`

- **Area:** Staff → ticket detail (`/staff/tickets/:id`) — affects the **primary "Agent" role**
- **Steps:** Log in as `agent@…`; open any ticket; open the "Назначить исполнителя" (assignee) combobox and the "Применить макрос" picker.
- **Expected:** Assignee list (agents have `ticket.assign`) and macros populate.
- **Actual:** Both empty. Network shows **`GET /staff?limit=100 → 403`** and **`GET /admin/macros → 403`**. The Agent group has `ticket.assign` but the UI loads the **over-privileged** `GET /staff` (requires `staff.manage`) and `GET /admin/macros` (requires admin) to fill the dropdowns. Verified live: agent gets 403 on both; admin gets 200 on both; and `PATCH /tickets/:id/assign` itself would succeed for an agent.
- **Files:** `apps/web/lib/hooks/use-tickets.ts:513-525` (`useStaffOptions`), `:443-449` (`useMacroOptions`).
- **Fix:** add a lightweight "assignable staff" endpoint (gated by `ticket.assign`) and a staff-readable macros endpoint; point the dropdowns at those.

---

## S3 — confirmed defects (minor / cosmetic / test)

### BUG-003 — Sub-department creation impossible via admin UI `[CONFIRMED]`

- **Steps:** Admin → Departments → "Добавить отдел". **Actual:** dialog has only a "Название" input — no parent-department selector (dialog text: _"Новый отдел / Название / Отмена / Сохранить"_). Sub-departments can only be made via API. (DTO + hook support `parentId`; only the control is missing. NEXT_GOAL claims this verified — it is not.)
- **File:** `apps/web/app/(admin)/admin/departments/departments-content.tsx:163-179`. **Fix:** add a parent `<Select>` from `GET /departments/tree`.

### BUG-004 — Notification bell is a permanent empty mock `[CONFIRMED]`

- **Steps:** Any staff page → click the bell. **Actual:** opens to "Нет уведомлений" always; no `/notifications` request; `MOCK_NOTIFICATIONS = []`. No real notification feed exists (no crash, just non-functional).
- **File:** `apps/web/components/premium/NotificationBell.tsx:20`.

### BUG-005 — `GET /auth/me → 401` console noise on public client pages `[CONFIRMED]`

- **Steps:** Visit `/submit`, `/tickets`, `/kb` unauthenticated → DevTools console shows repeated 401s (plus some 400s). Cosmetic; should gate `useMe` on token presence (QA S7, only partly addressed).

### BUG-006 — Playwright e2e suite is red (14/18 on clean DB) `[CONFIRMED]`

- **Run:** `npx playwright test --project=chromium` against the live stack → **14 passed / 4 failed** (all 4 = `kanban.spec.ts`).
- **Cause:** the kanban specs (a) **never log in** — comment says _"in test env, no auth gate"_ but the `middleware.ts` route guard now redirects `/staff/kanban` → `/login`; and (b) assert `getByRole("list", {name:/Колонка/})` from the old Framer `Reorder.Group` (the board was rewritten to native HTML5 DnD with `<div aria-label="Колонка …">`). **Both are stale-test issues, not a broken board** (the board renders 8 cards live). The "18/18 passing" claim in `docs/FINAL_REPORT.md` / `NEXT_GOAL.md` is inaccurate.
- **File:** `apps/web/e2e/kanban.spec.ts:5,11`. **Fix:** add a login step + update selectors to the current DOM.

---

## CODE-level findings (located in source; not individually executed live)

These come from the 15-agent code sweep with file:line evidence; I did not reproduce each through the UI. Triage before shipping.

| ID      | Sev | Finding                                                                                                                                                                        | File                                                    |
| ------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| BUG-007 | S2  | Macro **`isShared` is phantom** — no Prisma column, not in DTO/service; checkbox value lost on save                                                                            | `prisma/schema.prisma:535-544`, `workflow/dto.ts:30-39` |
| BUG-008 | S2  | Workflow **`send_email` action is a no-op** (logs a warning) though offered in the UI                                                                                          | `workflow/workflow.executor.ts:163-165`                 |
| BUG-009 | S2  | Macro **`replyText` + action builder absent in UI** → UI-created macros have empty reply/actions                                                                               | `admin/workflows/workflows-content.tsx:54-59`           |
| BUG-010 | S3  | KB article body lacks typography — `prose` class is a no-op (`@tailwindcss/typography` not installed). Only visible with rich HTML (seed content is plain, so low live impact) | `kb-article-content.tsx:66`; `apps/web/package.json`    |
| BUG-011 | S3  | KB category "N статей" count includes drafts (latent; ok while all published)                                                                                                  | `knowledgebase.service.ts:33`                           |
| BUG-012 | S2  | "SLA breached" stat-card filter is **client-side only** (no server param) → wrong across pages                                                                                 | `use-tickets.ts:251-254`                                |
| BUG-013 | S2  | **Silent MOCK fallback** — `useDashboardStats`/`useTickets`/`useKB*` `catch`→return mock data; a 500/expired-token shows fake content with no error state                      | `use-tickets.ts:554`, `use-kb.ts:64,84`                 |
| BUG-014 | S2  | Ticket management panel **hidden below 1280px** (`hidden xl:block`) — no status/priority/assignee on tablet/mobile                                                             | `ticket-detail-content.tsx:329`                         |
| BUG-015 | S2  | **No per-endpoint rate-limit on `POST /tickets/public`** (only global 300/60s) → ticket spam/DoS                                                                               | `tickets.controller.ts:63-77`                           |
| BUG-016 | S3  | i18n language switch is a no-op and not persisted (locale in `useState("ru")`; nav labels hardcoded RU)                                                                        | `providers.tsx:30`, `SidebarNav.tsx:26-30`              |
| BUG-017 | S3  | Client cannot reply on a **resolved** ticket (form hidden) → `publicReply` reopen path unreachable from UI                                                                     | `client-ticket-detail.tsx:109`                          |
| BUG-018 | S3  | Client reply has no error handling (`mutateAsync` unguarded) → unhandled rejection on failure                                                                                  | `client-ticket-detail.tsx:45-48`                        |
| BUG-019 | S3  | Duplicate `id="reply-textarea"` on reply + note tabs (hotkey/label target wrong one)                                                                                           | `ticket-detail-content.tsx:287,296`                     |
| BUG-020 | S3  | Department tree only nests 2 levels                                                                                                                                            | `departments.service.ts:16`                             |
| BUG-021 | S3  | Admin `catch {}` swallows API 400/409 `issues[]` detail → generic toasts (QA S6)                                                                                               | all `admin/*/-content.tsx`                              |
| BUG-022 | S3  | Radix `DialogContent` missing `DialogDescription`/`aria-describedby` (~9 dialogs) → a11y console warnings                                                                      | admin dialogs                                           |
| BUG-023 | S3  | Kanban: `onDragLeave` flicker, no optimistic-rollback on PATCH failure, 50-card cap (no pagination), skeleton 4 cols vs 5                                                      | `KanbanBoard.tsx:100,160-171`; `kanban-content.tsx:11`  |
| BUG-024 | S3  | Web `middleware.ts` is presence-only (no role check) — an agent can briefly SSR `/admin/*` before client redirect (API still enforces perms)                                   | `middleware.ts:22`                                      |
| BUG-025 | S3  | Attachment progress bar cosmetic (0→100 instant); oversized files dropped silently; note attachments orphaned                                                                  | `FileUploadZone.tsx:92,112`; `use-tickets.ts:369-370`   |
| BUG-026 | S3  | Custom-field type badge likely raw UPPERCASE (`NUMBER`) — unverified (no visible fields on clean stack to confirm)                                                             | `custom-fields-content.tsx:106`                         |

---

## Corrections to earlier claims (intellectual honesty)

These were stated as problems in an earlier static-analysis pass but are **NOT bugs** in the running build (the working tree was being edited mid-analysis, so my reads went stale — live testing corrected them):

1. **"JWT dual-stored in localStorage → XSS theft" — FALSE.** Live build is cookie-only: `localStorage.auth_token` absent, only a non-sensitive `th_authed=1` marker; real tokens in HttpOnly cookies. `api.ts` `clearTokens()` actively removes any legacy localStorage tokens. **AU-4 is properly fixed.**
2. **"Staff `getTicket` leaks `user.passwordHash`" — FALSE.** `GET /tickets/1` returns `user:{id,fullName,emails}` only — no `passwordHash`. Staff endpoints use a narrow select.
3. **Agent prediction "login → redirect loop" — NOT reproduced.** Login works for both roles.
4. **QA P0-4…P0-10 admin form 400s — fixed.** All admin create POSTs return 201.
5. **QA CL-3/4/5 client portal broken — fixed.** my-tickets, public detail, public reply all work.

---

## Production-deployment blockers (not functional bugs — config)

Carried from the prod-readiness audit; still apply for a real deployment:

- `docker-compose.yml` runs **`NODE_ENV=development`** (cookies `secure:false`, dev logging) and **re-seeds demo admin `demo1234` on every boot**; `NEXT_PUBLIC_API_URL` baked to `localhost`; no TLS / restart policy / secret management.
- Secret validation is length-only (`min(32)`) — "change-me" placeholders pass; Alaris webhook secret has a known default.
- No CI/CD (by design) → these gates never run automatically.

---

## Test environment notes

- Tested against the **currently-deployed Docker images** with a **fresh DB**. After testing, the DB now contains test entities (QA dept/staff/group/SLA/workflow/status + several tickets; ticket 1 status/priority changed). **Run `docker compose down -v && up -d` to restore a pristine seed.**
- Native HTML5 kanban drag-and-drop could not be exercised via synthetic events headlessly; the underlying `PATCH /tickets/:id/status` (which the board calls) is verified working, so drag-persist is sound at the data layer — UI drag itself is **unverified**, not failed.
- Companion doc: **`e2e_23rd_test_goal.md`** (prioritized /goal worklist with the full per-area scenario appendix).

```
Recommended fix order: BUG-002 (agents can't assign) → BUG-001 (priority dropped) →
BUG-007/008/009 (macros/workflows) → BUG-013 (mock-fallback hides errors) → BUG-006 (fix e2e specs) → S3 tail.
```
