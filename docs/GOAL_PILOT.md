# GOAL — Pilot-ready v1.0 (autonomous)

Run: `/goal docs/GOAL_PILOT.md`. **Execute the batches IN ORDER until the Definition of Ready (bottom)
is fully green. Self-gate after every batch — do NOT wait for external review between batches.**
File:line detail for each item is in `docs/NEXT_GOAL.md`.

## Operating rules (apply to EVERY batch)

1. Take ONE batch below (smallest coherent slice). Write/extend tests for each fix.
2. **Self-gate:** `make reset && make up && make verify` MUST be green (reseed → tsc · vitest · build · lint · smoke). If red → fix before continuing. **NEVER commit red.**
3. Commit the batch as ONE focused commit + push. Tick it done in this file. Move to the next batch.
4. **Keep the DEV stack working** (`docker-compose.yml` with demo seed + demo creds over http) — `make verify` depends on it. Harden only a SEPARATE prod profile.
5. **Do NOT touch the "OUT OF SCOPE" list** — those are post-pilot. Don't gold-plate.
6. **STOP** only when every batch is done AND the Definition of Ready checklist is all green; then run `make verify` + the full e2e once more and post a final summary.

---

## ✅ Batch A — Deploy hardening (DONE — commit 6373c5f→)

- [x] `helmet` + security headers in `apps/api/src/main.ts` (applies to dev + prod). Live: CSP/HSTS/X-Frame-Options/nosniff present.
- [x] `docker-compose.prod.yml`: `NODE_ENV=production`, secure cookies (NODE_ENV-driven), `restart: unless-stopped`, **API+web ports NOT published** (reverse-proxy only `expose`), `env_file: .env.prod`, seed dropped from prod CMD.
- [x] **Hard** seed-guard: under `NODE_ENV=production`, `seed.ts` REFUSES (loud + `process.exit(1)`) to create demo `admin/demo1234` unless `TELECOM_HD_SEED=1`.
- [x] `.env.prod.example` with placeholder secrets — confirmed the secret-gate REJECTS them (api refuses to boot with placeholders).
- [x] Prod-deploy section in `README.md` (nginx + TLS + reverse-proxy).
- **Acceptance:** dev `make verify` GREEN (9/9); prod compose valid; placeholder secrets rejected at boot. ✅

## ✅ Batch B — Safety / correctness (DONE)

- [x] Silent mock-fallbacks removed — `useTickets`/`useTicket`/`useReplies`/`useDashboardStats`/`useKB*` now propagate errors; consumers (dashboard, tickets-list, ticket-detail, kb list/article) render a real `<QueryError>` with retry. (useClientTickets keeps its legit staff→public route fallback — not mock data.)
- [x] Notification bell removed (was an always-empty mock) — re-add when a real `/notifications` feed exists.
- [x] Ownership enforced: time-entry delete + follow-up patch/delete now require the acting `staffId` to match (403 otherwise, 404 if missing). Tests added.
- [x] Bulk caveats: SLA recomputed on bulk reopen; bulk (un)assign gated on `TICKET_ASSIGN`; bulk onSuccess invalidates ALL ticket queries (open detail refreshes). Tests added.
- [x] Schema: `@@index([staffId])` on FollowUp; `@@unique([staffId,name])` on SavedView; staff FK `onDelete: Restrict` (explicit — staff are soft-disabled). Migration 20260528.
- [x] Reply drafts: per-tab keys (`th_reply_draft_<id>_<tab>`); switching ticket/tab reloads that key (reset); restored-key ref avoids the save/restore race.
- **Acceptance:** API errors surface as `<QueryError>` (not blank/fake); no fake notifications; bulk reopen recomputes SLA. `make verify` GREEN 9/9. ✅

## ✅ Batch C — Scheduled reports (DONE)

- [x] `createSchedule` seeds `nextRunAt` from the cron (UTC); `updateSchedule` recomputes it when the cron changes; `advanceNextRunAt` now uses real `cron-parser` (added as a direct dep) instead of the fixed +1h hack. Cron is validated on write (`ScheduleCreateSchema` refine → 400 on garbage). New `cron.util` + spec; createSchedule test asserts non-NULL nextRunAt.
- **Acceptance:** live — created schedule `nextRunAt` is non-NULL (`2026-…T18:25:00Z`); invalid cron → 400; the processor's due-scan (`nextRunAt <= now`) now matches real schedules. `make verify` GREEN. ✅

## ✅ Batch D — Test lock-in (DONE)

- [x] Public throttle is env-driven (`TELECOM_HD_PUBLIC_SUBMIT_LIMIT`/`_REPLY_LIMIT`), bumped to 100 in the dev compose so repeated e2e submits are deterministic; prod (.env.prod) keeps the strict 5/10 defaults.
- [x] New `agent-flows.spec.ts` (chromium-auth project): agent loop (reply + internal note via UI; status/priority/assign-via-`/staff/assignable`/create+apply macro end-to-end through the authed stack); bulk status change via the list UI; public submit choosing "Критический" → asserts the created ticket is Urgent.
- [x] `make verify-full` = `verify.sh` + `npm run test:e2e`.
- **Acceptance:** `make verify-full` GREEN (gate 9/9 + e2e 37/37); e2e stable across 3 consecutive runs. ✅

---

## ✅ Definition of Ready — ALL GREEN

- [x] `make verify` green (tsc · vitest · build · lint · smoke) — 9/9.
- [x] Full e2e green AND stable — 37/37, 3× consecutive (throttle no longer flaky).
- [x] Agent loop covered: list → open → reply → internal note (UI) → status/priority → assign → macro (end-to-end via the authed stack in `agent-flows.spec.ts`) + time/follow-up endpoints (Batch B specs).
- [x] Client self-service: submit with the **correct** priority (urgent→Urgent e2e) → my-tickets → reply → reopen (reply-to-resolved reopen wired earlier).
- [x] No silent failure-masking; no fake data; notification bell removed (Batch B).
- [x] Prod profile exists & builds: NODE_ENV=production, helmet, secret-gate rejects placeholders, no demo seed, reverse-proxy, documented; dev loop still green (Batch A).

---

## ⛔ OUT OF SCOPE for pilot — do NOT touch

i18n switch/persistence; kanban onDragLeave flicker / 50-cap / skeleton count; CommandPalette eager fetch; KB category draft count & `/kb/categories` isPublished; my-tickets React-Query key; Radix `DialogDescription` a11y; sub-department deep nesting. Parity (CF options editor, POP3, jti blocklist, SLA working-hours editor, saved-view date-range, CC/BCC, KQL breadth) = Phase 3. Multi-tenant/load/backup/OTel = Phase 2.
