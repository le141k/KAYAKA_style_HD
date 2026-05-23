# GOAL — H8: fixes from the H5-H7 review (next batch)

Independent review of committed **H5 (0641010) / H6 (10d0a7b) / H7 (e99cb31)** by 8 read-only agents
(code-level; live repro deferred — migration agent was mid-M0 on the shared stack). The agent's
security fixes **verified good**; these are NEW bugs the review surfaced. Same discipline: one batch,
test per fix, `make reset && up && verify` green, never commit red, one commit.

## ✅ Verified good in H5-H7 — do NOT re-touch

- HIGH-A staff PII leak: `getPublicTicket` posts now use an explicit `select` (no email/ipAddress/staffId) — confirmed in code.
- HIGH-B `upload/public` `@Throttle` present (3×201→429).
- jti fail-open now logs a throttled ERROR alert (fail-open preserved, no regression).
- Storage path guard core (`resolve`+`relative`+`startsWith`) correct for `../`/absolute; read+delete covered.
- i18n `kanbanPage` complete (ru/en/uk, type-enforced); dead "Профиль"→/admin/staff link removed; "Настройки" role-gated cleanly.
- No regressions to staff `getTicket`/list/auth'd upload-download/macro-edit. New specs are real (no skip/only).

---

## 🔴 HIGH

- **[H8-1] `assign` action vocabulary mismatch (silent no-op / no notification).** The new H7 macro/workflow action builder emits `{type:'assign'}`, but the **workflow executor has no `case 'assign'`** (only `change_owner`/`assign_staff`) → a workflow "assign" action does nothing (`workflow.executor.ts` ~120). In `applyMacro` the macro path DOES set `ownerStaffId` but via raw `ticket.update`, **bypassing `assign()`** so the assignment notification never fires (`tickets.service.ts` ~1307). **Fix:** unify the action-type vocabulary between the UI builder and BOTH executors; route assign through `assign()` (notification + audit).
- **[H8-2] Workflow criterion dropdown breaks existing rules.** The criterion `field` is now a `<select>`; an existing workflow saved with a free-text field value NOT in the option list silently renders as the **first option (`subject`)** while keeping the stale value until re-saved — no warning, corrupts the rule on edit (`workflows-content.tsx`). **Fix:** detect unknown stored field → show it as a distinct "(unknown: X)" option + warn; don't silently snap to `subject`.

## 🟠 MEDIUM

- **[H8-3] Orphan-claim-token bypass (IDOR partially re-open).** `attachmentClaimToken` is `.optional()`; if a hand-crafted public submit omits it, `linkToPost` falls back to **no token filter** (`{id in ids, postId:null}`) → any orphan adoptable by id (`attachments.service.ts` ~73, `tickets/dto.ts`). The UI always sends it, so normal users are safe, but the guard is bypassable. **Fix:** on the public create/reply path, REQUIRE a matching claimToken when `attachmentIds` is present (reject/ignore otherwise). Add a test that omitting the token fails adoption.
- **[H8-4] Empty-token SSR path** — `submit-form.tsx` `claimToken` falls back to `''` (no-crypto/SSR); Zod `.uuid()` strips it → same bypass AND can silently drop a legit attachment. Generate the token lazily client-side; don't send `''`.
- **[H8-5] Macro actions skip existence validation.** `set_priority`/`assign`/`change_department` go through a raw batch `ticket.update` with no FK/existence check (only `set_status` is routed via `changeStatus()`). A macro can set a dangling `priorityId`/`ownerStaffId`/`departmentId`. **Fix:** validate referenced ids (or route through the existing change\* helpers). Add a test for UI-built `{type:'assign', value:'N'}`.

## 🟡 LOW

- **[H8-6]** Storage guard: empty-string `storageKey` bypasses the `BadRequestException` (passes to fs); symlink escape unmitigated (no `realpath`). Add empty-key reject + a test.
- **[H8-7]** Orphan attachments never GC'd → unbounded growth (throttled but unbounded). Add a cleanup of `postId IS NULL` orphans older than N hours.
- **[H8-8]** `add_tag`/`add_note` macro values have no length cap.
- **[H8-9]** `FileUploadZone` shows no user-visible error when an upload fails (silent `error` state).
- **[H8-10]** "Выйти" (logout) label still hardcoded RU in `staff/layout.tsx:152` (key `logout` exists in dicts — wire it).
- **[H8-11]** Workflow boolean criteria (`isResolved`/`isEscalated`) only match exact `"true"`/`"false"` strings with no UI hint.

## Definition of Done

- H8-1..5 fixed with tests (esp. assign-fires + notification; criterion backward-compat; token enforced on public adopt); LOW items as time permits.
- `make verify-full` green; live repro: workflow/macro `assign` actually assigns + notifies; omitting claimToken on public submit does NOT adopt others' orphans.
