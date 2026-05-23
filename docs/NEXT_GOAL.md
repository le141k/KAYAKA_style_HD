# NEXT-GOAL WORKLIST — 23 Telecom Help Desk

> **Rewritten 2026-05-23 from an independent live audit at HEAD `5fd04ea`** (coordinator + 15 agents,
> driven against the running Docker stack on a fresh seed + direct API probes). Supersedes all prior
> content. Tags: **[LIVE]** = reproduced against the running stack · **[API]** = confirmed via API call ·
> **[CODE]** = located in source (file:line), not run live.
>
> Discipline for the next `/goal`: fix in priority order → unit/integration test → `tsc`/`vitest` green →
> `docker compose down -v && up -d` (or `build --no-cache` if code changed) → re-verify the item live →
> commit/push. Demo: `admin@23telecom.example` / `demo1234`, `agent@23telecom.example` / `demo1234`.
> Login throttle 5/60s, global 300/60s.

## Build & test health (verified at 5fd04ea)

- ✅ `vitest` **478/478**, `nest build` 0, `next build` 0 (19 pages), api+web `tsc` 0. **[LIVE]**
- ❌ root `npm run lint` fails — **3 unused-var errors in `scripts/audit-dashboard-kanban.mjs`** (QA helper, not app code). Trivial: delete/clean that script or `eslintignore` it. **[LIVE]**

## ✅ Verified DONE this cycle — do NOT re-touch

- **SEC-1** no `passwordHash` leak anywhere (SAFE_USER_SELECT / SAFE_STAFF_SELECT / PUBLIC_USER_SELECT used across tickets/users/staff/orgs/notifications; live responses clean). **[API]**
- **SEC-2** cookie-only auth (HttpOnly `th_access`/`th_refresh`, JS sees only `th_authed`; no JWT in localStorage). **[LIVE]**
- **React #418** hydration fixed & committed (`RelativeTime.tsx`, `SlaPill.tsx` mounted-gate). **[CODE]**
- **Admin create** departments/staff/custom-field-groups/SLA-plans/workflows/statuses all → **201**. **[LIVE]**
- **Client portal** submit / my-tickets (client_email) / public detail / public reply / reopen-on-reply. **[LIVE/API]**
- **Security backstops** global JwtAuthGuard+PermissionsGuard+ThrottlerGuard + PrismaExceptionFilter; IDOR→404, isAdmin escalation blocked, bad-id→404, bad-FK→400 (not 500). **[API]**
- **New P3 modules wired** time-tracking / follow-ups / saved-views registered, in Swagger (104 paths/168 ops), behind guards; happy paths create→201; saved-views correctly scoped per-staff. **[LIVE]**
- **BUG-026** custom-field type label localized. **CF NUMBER** type. **[CODE]**

---

## P1 — functional bugs, fix first (all CONFIRMED open)

- **[P1][LIVE] BUG-001 — priority dropped on public submit.** `POST /tickets/public` with `priorityId:4` → ticket gets `priorityId:1`. `PublicCreateTicketSchema` has no `priorityId`; Zod strips it. **Fix:** add `priorityId?` to schema (`apps/api/src/modules/tickets/dto.ts:137-146`) + pass through controller; expose on `PublicTicketInput` (`use-tickets.ts:368-374`, `submit-form.tsx:102`).
- **[P1][LIVE] BUG-002 — agents can't assign or apply macros.** Agent `GET /staff`→403 and `GET /admin/macros`→403; the assignee dropdown + macro picker (and the **bulk-assign** dropdown) are empty for the primary role. **Fix:** add an assignable-staff endpoint gated by `ticket.assign` and a staff-readable macros endpoint; repoint `useStaffOptions`/`useMacroOptions` (`use-tickets.ts:~513,443`).
- **[P1][CODE] Macros are hollow (BUG-007/008/009).** `Macro.isShared` not in schema/DTO → silently lossy (`schema.prisma` Macro, `workflow/dto.ts:30-39`); macro dialog has **no replyText textarea and no action builder** (`workflows-content.tsx:609-649`) → UI macros do nothing; workflow `send_email` action is a **no-op** (`workflow.executor.ts:163-165`). Macros/automations are non-functional from the UI.
- **[P1][LIVE] Bulk actions: silent partial failure, no transaction.** `[1,999999]` → `{updated:1}` with no failed-ids reported; loop swallows errors, no atomicity, N+1 (`tickets.service.ts:683-698`). **Fix:** `$transaction` or return `{updated, failed:[]}`; add UI loading/disable to prevent double-submit; add bulk-**unassign** option.
- **[P1][LIVE] `sla_breached` list filter is client-side only** → wrong counter + broken pagination across pages (`use-tickets.ts:251-254`; no `slaBreached` in `ListTicketsQuerySchema`). Push to the server query.
- **[P1][CODE] Ticket list omits tags** — `listTickets` has no `include:{tags}`, so every row's `tags` is `undefined` (`tickets.service.ts:441-459`).

## P2 — correctness / security gaps

- **[P2][LIVE] No ownership check on time-entries & follow-ups.** Admin deleted an agent's time entry (204) and completed an agent's follow-up (200); endpoints only require `TICKET_EDIT`, no `staffId` match (`time-tracking.controller.ts:43`, `follow-ups.service.ts:33-55`). Decide policy; add ownership (or document as intended). SavedView scoping IS correctly enforced (admin can't see/delete agent's view → 404).
- **[P2][CODE] Reply drafts share one field across reply/note tabs** — both `TabsContent` bind `register('body')` (`ticket-detail-content.tsx:312,322`); note clobbers reply draft. Also `draftRestored` not reset on ticket switch without unmount. (Duplicate `id="reply-textarea"` IS fixed → `note-textarea`.)
- **[P2][CODE] Client reply: form hidden on resolved/closed** (`client-ticket-detail.tsx:109`) so the (working) reopen-on-reply backend path is unreachable from the portal; and `mutateAsync` is unguarded (`:46`) → unhandled rejection on error.
- **[P2][CODE] PROD hardening incomplete.** `helmet`/security headers **absent** (`main.ts`); prod compose still invokes the seed binary (guard is a soft skip, not hard-abort) and publishes API :4000; no `.env.prod.example`. Secret-gate, prod compose, secure cookies ARE in place.
- **[P2][CODE] Mock fallbacks hide API errors** — `useDashboardStats`/`useTickets`/`useKB*`/`useClientTickets` `catch`→return mock/empty, so 500/403 look like real/empty data with no error UI.
- **[P2][CODE] Notification bell is a permanent empty mock** (`NotificationBell.tsx:20`); no `/notifications` endpoint (BUG-004).
- **[P2][CODE] BUG-003 sub-department creation impossible via UI** — no parent selector in the dept dialog (`departments-content.tsx:163-179`).
- **[P2][CODE] Schema gaps:** `FollowUp.staffId` missing index; `TimeEntry`/`FollowUp` staff FK `onDelete: Restrict` (blocks staff deletion); `SavedView` no `@@unique([staffId,name])`, no filters size cap, no edit endpoint.

## P3 — polish / cosmetic

- KB article body unstyled (`@tailwindcss/typography` not installed; `prose` no-op) — BUG-010.
- i18n switch is a no-op / not persisted (`providers.tsx:30`); nav labels hardcoded RU.
- Kanban: `onDragLeave` flicker, no optimistic rollback, 50-card cap, skeleton 4-vs-5 cols (BUG-021).
- `kanban.spec.ts` doesn't log in + uses stale `role="list"` selectors → 4 e2e failures (board itself works). Fix specs.
- CommandPalette fires `GET /tickets?limit=5` on every open even with empty query.
- KB category count includes drafts (`knowledgebase.service.ts:33`); `isPublished` leaked on `/kb/categories`.
- my-tickets React-Query key frozen at mount (`use-client-tickets.ts:157`).
- Admin `catch{}` swallows API 400/409 detail (generic toasts); Radix dialogs missing `DialogDescription` (a11y).
- Long-tail parity: CF options editor, POP3, jti revocation blocklist, SLA schedule working-hours editor (dialog is title-only), saved-view date-range persistence.

---

_Companion reports: `BUG_REPORT.md` (full repro/severity/evidence) · `e2e_23rd_test_goal.md` (per-area scenarios)._
