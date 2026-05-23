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

## ☐ Batch B — Safety / correctness (no silent lies)

- [ ] Replace silent mock-fallbacks with real error states — `useDashboardStats`/`useTickets`/`useKB*`/`useClientTickets`: on API error show an error UI, never fake/empty-as-real data.
- [ ] Notification bell: wire a minimal real `/notifications` feed OR hide the bell (remove the empty mock).
- [ ] Ownership on time-entries & follow-ups: enforce `staffId` match on delete/patch (or, if team-shared is intended, document it AND still gate delete).
- [ ] Bulk caveats: recompute SLA on bulk status change/reopen; gate bulk-assign on `TICKET_ASSIGN`; invalidate open ticket-detail query after a bulk op.
- [ ] Schema: add `@@index([staffId])` to `FollowUp`; `@@unique([staffId,name])` to `SavedView`; decide `onDelete` for `TimeEntry`/`FollowUp` staff FK (migration).
- [ ] Reply drafts: separate keys for reply vs internal-note tab; reset on ticket switch.
- **Acceptance:** an API 500/403 surfaces as an error (not blank/fake); no fake notifications; bulk reopen recomputes SLA.

## ☐ Batch C — Scheduled reports

- [ ] Set `nextRunAt` from the cron on `createSchedule` (`reports.service.ts:173`); real cron-parse in `advanceNextRunAt` (`report-schedule.processor.ts:21`). Add a test that a due schedule fires.
- **Acceptance:** a created schedule has a non-NULL `nextRunAt` and the processor runs it.

## ☐ Batch D — Test lock-in (DO LAST so the gate is strongest)

- [ ] Make e2e deterministic vs the public throttle (raise/exempt the limit under test, or serialize submit tests).
- [ ] Add e2e: agent full workflow (assign via `/staff/assignable`, apply macro, reply, status), bulk action, public submit-with-priority (urgent→Urgent).
- [ ] Add a `verify-full` make target that also runs `npm run test:e2e`; wire it into the gate.
- **Acceptance:** `make verify-full` green and repeatable.

---

## ✅ Definition of Ready — STOP when ALL are green

- [ ] `make verify` green (tsc · vitest · build · lint · smoke).
- [ ] Full e2e green AND stable (not throttle-flaky).
- [ ] Agent role does the whole loop in the UI: list/filter → open → reply → internal note → status/priority → **assign** → **macro** → time/follow-up.
- [ ] Client self-service: submit with the **correct** priority → my-tickets → reply → reopen.
- [ ] No silent failure-masking; no fake data shown as real; notifications real or removed.
- [ ] Prod profile exists & builds: `NODE_ENV=production`, helmet, real secrets, **no demo seed**, behind reverse-proxy — documented. Dev loop still works.

## ⛔ OUT OF SCOPE for pilot — do NOT touch

i18n switch/persistence; kanban onDragLeave flicker / 50-cap / skeleton count; CommandPalette eager fetch; KB category draft count & `/kb/categories` isPublished; my-tickets React-Query key; Radix `DialogDescription` a11y; sub-department deep nesting. Parity (CF options editor, POP3, jti blocklist, SLA working-hours editor, saved-view date-range, CC/BCC, KQL breadth) = Phase 3. Multi-tenant/load/backup/OTel = Phase 2.
