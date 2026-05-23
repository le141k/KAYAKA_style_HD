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

## ✅ DONE in 5a059ac + 82ad9f8 (verified live by audit) — do NOT re-touch

- BUG-001 priorityId now flows to public submit; BUG-002 `/staff/assignable` + `/admin/macros/options` (agent→200, full routes still 403); macros `isShared` column + set_status fallback + `send_email` wired; KB typography; client reopen-on-reply; **bulk** `$transaction` + `{updated,failed[]}` + unassign (live `{updated:2,failed:[99999]}`); **sla_breached** server-side (accurate totals); **listTickets include tags**; e2e 33/33 (clean window); lint 0; vitest **482/482**.

## ✅ DONE in 6373c5f (verified live by audit) — do NOT re-touch

- **PRIORITY_MAP inversion FIXED** — submit-form resolves slug→id dynamically via new `@Public() GET /ticket-priorities/public`; gold-standard live: form pick «Критический» → sends `priorityId:4` (Urgent). **z.coerce.boolean footgun FIXED** — new `common/zod-bool.util.ts` (explicit preprocess) on `sla_breached`/`unassigned`/`isResolved`/`publishedOnly`/`enabled`; live `?sla_breached=false`→total 5 (no longer filters). **Tags rendered** in `TicketRow` (≤3 chips). vitest **489/489**, builds 0, lint 0.

## P1 — fix first (found during verification)

- **[P1][CODE] Scheduled reports are dead** — `createSchedule` never sets `nextRunAt` (NULL), and the processor filters `nextRunAt <= now` (NULL never matches) → no schedule ever fires (`reports.service.ts:173`, `report-schedule.processor.ts:49`). Manual run works. **Fix:** compute `nextRunAt` from cron on create + real cron-parse in `advanceNextRunAt`. _(Not a pilot blocker — manual run works; sequence after Batch 4.)_

## 🔑 NEXT (agreed): Batch 4 — deploy hardening (the pilot "ready" gate)

- helmet/security headers (`main.ts`); separate **prod profile** (`docker-compose.prod.yml`: NODE_ENV=production, secure cookies, restart, API port not published); **hard** seed-guard (refuse demo `demo1234` in production, not silent skip); `.env.prod.example`; deploy README. **Must NOT break the dev compose / `make verify` loop** (keep demo seed in dev).

## P1.5 — caveats from the 82ad9f8 fixes (close soon)

- **[LIVE] Bulk bypasses SLA recalculation + events** (raw `tx.ticket.update`, intentional "no spam") → SLA `dueAt` not recomputed on bulk reopen; bulk-assign requires only `TICKET_EDIT` (single-assign needs `TICKET_ASSIGN`); web doesn't invalidate open ticket-detail queries after bulk. `tickets.service.ts:694-754`.
- **[CODE] Tags fetched but not rendered** — `listTickets` now returns tags, but `TicketRow.tsx` never displays them → still invisible in the list. Render them.

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
