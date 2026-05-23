# ROADMAP — 23 Telecom Help Desk

> Built 2026-05-23 from the live audit at HEAD `5fd04ea`. Target spine = **Pilot v1.0** (recommended
> cutoff); Prod and Parity are explicit later phases — move the cutoff if the goal is bigger.
> Every batch is **small + independently verifiable**: it is "done" only when `make verify` is green
> **and** the matching scenario is re-checked live. Source of truth for items: `docs/NEXT_GOAL.md`
> (file:line) + `BUG_REPORT.md` (repro/severity).

## Execution loop (applies to every batch)

1. Fixer takes ONE batch below (small), writes a test per fix.
2. `make reset && make up && make verify` → must be **GREEN**.
3. Independent live re-check of the batch's scenario (the bug's repro) → pass/fail with evidence.
4. Commit only green batches. Never two writers on the same tree + stack at once (see coordination).

---

# Phase 1 — Pilot v1.0 (1 support team uses it for real)

### Definition of Done (acceptance)

- `make verify` green: api+web `tsc`, `vitest`, `build`, `lint`, live smoke.
- Playwright suite green (after the stale kanban specs are fixed) and wired into the gate.
- **Agent role** (not just admin) can do the full loop end-to-end: list/filter → open → reply → internal note → change status/priority → **assign** → **apply macro** → log time / follow-up.
- **Client self-service** works: submit (with chosen **priority**) → my-tickets → reply → reopen.
- No silent data/sec holes: ownership policy decided on time/follow-ups; no fake/mock data shown as real.
- Deployable single-tenant with a documented prod profile (NODE_ENV=production, real secrets, helmet, no demo seed) behind a reverse proxy.

### Batch 1 — Functional blockers (P1) · size M

- **BUG-001** priority on public submit → add `priorityId?` to `PublicCreateTicketSchema` + controller pass-through + `PublicTicketInput` (`tickets/dto.ts:137`, `submit-form.tsx:102`).
- **BUG-002** agent assignee + macro pickers → add assignable-staff endpoint gated by `ticket.assign` + a staff-readable macros endpoint; repoint `useStaffOptions`/`useMacroOptions` (`use-tickets.ts:~513,443`).
- **Bulk** → wrap in `$transaction` or return `{updated, failed[]}`; add UI loading/disable; add bulk-unassign (`tickets.service.ts:683`).
- **sla_breached** filter → move server-side; **list include tags** (`use-tickets.ts:251`, `tickets.service.ts:441`).

### Batch 2 — Make automations real · size M

- Macro `isShared` column + DTO + service (BUG-007); macro **replyText** textarea + **action builder** in UI (BUG-009); workflow **send_email** → wire to mail (BUG-008). _(Skip if the pilot team won't use macros — then just hide the dead controls.)_

### Batch 3 — Correctness / UX safety · size M

- Reply drafts per-tab (reply vs note) + reset on ticket switch.
- Client reply on resolved: show + reopen (or explain); guard `mutateAsync` (BUG-017/018).
- **Decide ownership policy** on time-entries/follow-ups (scope to creator vs team) + enforce.
- Replace silent mock-fallbacks with real error states (dashboard/tickets/kb hooks).
- Notification bell: wire a minimal real feed OR hide it (no fake) (BUG-004).
- Sub-department parent selector in admin dialog (BUG-003).
- Schema: `FollowUp.staffId` index, `SavedView @@unique([staffId,name])`, decide staff-FK onDelete.

### Batch 4 — Pilot deploy hardening · size S–M

- `helmet` + security headers (`main.ts`).
- Prod compose: `NODE_ENV=production`, hard seed-guard (no demo `demo1234`), secure cookies, real secrets via `.env.prod.example`, don't publish API :4000 (reverse proxy), restart policy.
- Make `make verify` lint green: remove/clean `scripts/audit-dashboard-kanban.mjs` (3 unused-var errors).

### Batch 5 — Lock it in with tests · size S–M

- Fix `kanban.spec.ts` (login step + current DOM selectors); add e2e for agent workflow (assign/macro/reply), client submit-with-priority, bulk. Add `npm run test:e2e` to the gate.
- **Decision to make:** the repo has `No CI/CD by design`. For a real product this is the main anti-drift lever — a tiny GitHub Action running `make verify` on PR would stop "done≠done" permanently. Recommend revisiting that rule.

**Phase 1 exit:** all 5 batches merged green → tag `v1.0-pilot`.

---

# Phase 2 — Prod SaaS v1.1 (public, multi-client) — _only if needed_

- Per-endpoint rate-limits (esp. `POST /tickets/public`), `GET /tickets/my` ownership/OTP.
- Load test (k6 script exists in `infra/`), DB backups, monitoring/OTel (flag exists), JWT jti revocation blocklist.
- Full RBAC review across all modules; multi-tenant data isolation review.
- Token-in-JSON-body removal (retire legacy Bearer path → fully close SEC-2 residual).

# Phase 3 — Kayako parity v2.0 (migration target) — _months_

- Attachments depth, CC/BCC, KQL reports breadth, email parser rules, POP3, data-migration tooling, saved-view/date-range, CF options editor.

---

## Coordination (multiple agents)

Two agents must **not** write the same working tree + drive the same live stack simultaneously.

- **Default (simplest): serialize.** Fixer finishes a batch + commits → verifier checks out that commit and runs the gate. No contention.
- **Parallel (if needed): isolate.** Each agent gets its own git worktree + its own compose project on shifted ports (e.g. web 3100 / api 4100). Then builds, DB, and edits don't collide.

_Companion docs: `NEXT_GOAL.md` (worklist, file:line) · `BUG_REPORT.md` (repro/severity) · `make verify` (the gate)._
