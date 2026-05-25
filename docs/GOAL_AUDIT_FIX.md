# GOAL — Fix the 16-agent production audit findings (autonomous)

Run: `/goal docs/GOAL_AUDIT_FIX.md`.

Consolidated, de-duplicated findings from an independent 16-agent read-only audit (2026-05-24) that
verified **against code + the live stack**, not docs. **Context:** the 4 "criticals" from the older
`docs/AUDIT_20AGENT_2026-05-24.md` were re-checked and are **already fixed** (merge guard, SLA
`isEscalated` filter, perf `take` caps, refresh-reuse detection) — do NOT re-do them. What remains is
**one real blocker (inbound email), a set of HIGH hardening items, and MEDIUM/LOW polish.**

> Each finding lists `file:line` from the audit. **First reproduce, then fix** — the audit may have
> drifted by a few lines. If a finding is already fixed, tick it and note "already fixed", don't invent work.

## Operating rules (EVERY batch) — same discipline as GOAL_HARDEN / GO_LIVE

1. ONE batch at a time, smallest coherent slice. Write/extend a test for each fix.
2. **Self-gate:** `make reset && make up && make verify` MUST stay green (dev profile, demo seed, http). Never commit red.
3. Security/integration fixes MUST be **live-verified** (curl / psql / a real container), the repro must now fail.
4. One focused commit + push per batch. Tick the item here. Keep `docs/` honest (update checkboxes in the SAME commit).
5. Keep the dev loop working (demo seed, MailHog). Harden only the prod profile.
6. Don't gold-plate, don't touch OUT OF SCOPE.
7. STOP when all batches done + DoD green; run `make verify-full` once more; post a summary.

---

## 🔴 Batch A — BLOCKER: inbound email path works end-to-end (against a LOCAL mailbox)

The core 23 Telecom flow — customer emails `noc@23telecom.co.uk` → auto **CLIENT** ticket → NOC spawns a
**LINKED SUPPLIER** ticket (`TicketLink`) — is **NOT reachable from a real email today**: the `noc@` queue
is `type=PIPE` with no handler, all IMAP queues are `isEnabled=false`, and no UID watermarks exist
(`inbound.service.ts:72-79` only queries `type:'IMAP'`). **Build & PROVE the whole mechanism against a
local IMAP container — real `noc@` IMAP creds / MX / DNS are 🙋 USER-LATER and do NOT block this batch.**

- [ ] **A1 — Inbound transport (both modes).** Make `InboundMailService` actually ingest: (a) robust **IMAP poll** (scheduled, idempotent via a per-queue UID/UIDVALIDITY watermark in `Setting`, survives restart); and (b) an **inbound webhook** `POST /api/inbound/pipe` that accepts a raw RFC822 message (for the MTA/PIPE case) guarded by a shared secret. Both feed the same parse→ticket pipeline. Handle/relabel the `noc@` `PIPE` queue so it is processed (or document converting it to IMAP). Reject/log `isEnabled=true` queues of unimplemented types instead of silently ignoring (`schema.prisma:79-82`).
- [ ] **A2 — Local IMAP integration test (NOT MailHog).** Stand up **GreenMail or Dovecot** in a test container. Deliver a real multipart MIME email → assert: a CLIENT ticket is created, requester org matched/created with correct `orgType`, body parsed (HTML+text, quote-strip on replies).
- [ ] **A3 — Threading + dedup.** Fix the empty-`messageId` default problem (`inbound.service.ts:284-307`, `schema.prisma:421`): every created post must carry a real Message-ID. A reply with matching `Message-ID`/`In-Reply-To` **threads** onto the same ticket; a re-poll of the same message creates **no duplicate**. Test both.
- [ ] **A4 — Spawn-supplier from inbound.** From an inbound client email, the NOC spawn-supplier path (auto or one-click) creates a separate SUPPLIER ticket with a two-way `TicketLink`; vendor macro renders. Test it.
- [ ] **A5 — Loop / bounce protection.** (i) Outbound autoresponder/notifications set `Auto-Submitted: auto-replied` (`mail.service.ts` deliver). (ii) Inbound skips messages with `Auto-Submitted`≠`no` / `Precedence: bulk` / `X-Loop` / self-from. (iii) **Workflow re-entry guard:** `applyMacro`→`changeStatus`→`ticket.status_changed`→`WorkflowExecutor` can recurse with no depth limit (`workflow.executor.ts`, `tickets.service.ts:~1566`). Add a per-ticket in-flight/depth guard in `WorkflowExecutor.evaluate()`. Also re-fetch the ticket between workflow evaluations (stale snapshot, `workflow.executor.ts:60-74`). Test: two auto-generated emails don't ping-pong; a `status→status` workflow doesn't loop.
- 🙋 **USER-LATER:** real `noc@` IMAP host/user/app-password, MX/DNS, and flipping the queue `isEnabled=true`. The bot does everything above against the local container + documents the exact env keys to fill.
- **DoD:** a real email delivered to the **local** IMAP container shows up as a **linked client+supplier ticket pair** in the UI; re-poll = no dup; threading + quote-strip + loop-guard all proven by tests; no recursion.

---

## 🟠 Batch B — HIGH security hardening

- [x] **B1 — Mass-assignment on ticket create/reply.** ✅ Dropped `creationMode`/`ipAddress` from `CreateTicketSchema`+`ReplyTicketSchema` (Zod strips them); staff controller forces `creationMode='STAFF'` + real `@Ip()`; trusted callers (public/alaris/inbound) still pass them via the service param. Test: `dto.mass-assignment.spec.ts`. Staff `CreateTicketSchema` (`tickets/dto.ts:24-25`) and `ReplyTicketSchema` (`dto.ts:42-43`) accept `creationMode` + `ipAddress`; the controller passes the DTO through (`tickets.controller.ts:~173,199`), so an agent can forge an `ALARIS`/`EMAIL` ticket, suppress the autoresponder, or spoof the IP. **Fix:** drop those fields from the staff schemas (or force `creationMode='STAFF'` + real `req.ip` in the controller). Test: posting `creationMode/ipAddress` is ignored.
- [x] **B2 — Staff-group privilege guards.** ✅ `permissions` validated against `ALL_PERMISSIONS` catalog in the DTO; `createGroup`/`updateGroup` take the actor and a non-admin may not create an admin group nor grant permissions it doesn't hold (`assertGroupPrivilege`). Tests added. `createGroup` accepts `isAdmin:true` with no actor check (`staff.service.ts:~50`), and `updateGroup` lets a `STAFF_MANAGE` holder set arbitrary `permissions` (incl. all admin perms) with no actor guard (`staff.service.ts:~54`, `staff/dto.ts:7,13`). **Fix:** (a) validate `permissions` against the `Permission` catalog (`z.enum(ALL_PERMISSIONS)`); (b) a non-admin actor may not create/grant `isAdmin` or any permission they don't already hold. Pass actor from the controller (as create/update already do). Test both. _(Latent today — only admin holds `STAFF_MANAGE` — but fix before delegating it.)_
- [x] **B3 — Last-admin / self-disable guard.** ✅ `assertNotLastAdmin` refuses to disable (or de-admin) the last enabled administrator, called from `disable()` and `update()` (on `isEnabled:false` or move to a non-admin group). Tests added. `update()`/`disable()` (`staff.service.ts:~162,196`) let a `STAFF_MANAGE` holder disable the last admin → lockout. **Fix:** refuse to disable the last enabled admin. Test.
- **DoD:** each repro now fails; `make verify` green; +tests.

---

## 🟠 Batch C — HIGH at scale (fine at ~1.4k tickets, breaks at ~50k)

- [x] **C1 — Refresh-token unbounded scan + no cleanup.** ✅ `refresh()` now caps both scans (`take:20`, newest first), opportunistically deletes the staff's expired tokens, and `@@index([staffId, revokedAt])` + `@@index([staffId, expiresAt])` added (migration `load_indexes_batch_c`). `auth.service.ts:~101-127` does two unbounded `findMany` over a staff's tokens with per-row argon2 verify; no expired-token cleanup; `RefreshToken` lacks `expiresAt`/`revokedAt` indexes. **Fix:** `take` cap (e.g. 20 newest), a cleanup job (delete `expiresAt < now()`), `@@index([staffId, revokedAt])` + `@@index([staffId, expiresAt])`.
- [x] **C2 — Ticket search.** ✅ `ListTicketsQuerySchema.search` trims + treats <3-char terms as no filter (so the trigram GIN index isn't bypassed by a seq-scan). Test added. `listTickets` ILIKE-OR over 4 columns seq-scans at low selectivity (`tickets.service.ts:~582`). GIN trgm indexes exist but the planner skips them for <3-char terms. **Fix:** enforce min 3-char `search` in the DTO; consider a generated `tsvector` column.
- [~] **C3 — Workflow load per event.** Index `@@index([isEnabled, sortOrder])` added + EXPLAIN-confirmed used. Short-TTL cache still TODO (next slice). `workflow.executor.ts:~64` runs `workflow.findMany({where:{isEnabled:true}})` on EVERY ticket event with no index/cache. **Fix:** `@@index([isEnabled, sortOrder])` on `Workflow` + short-TTL cache invalidated on workflow write.
- [x] **C4 — SLA N+1.** ✅ `runPeriodicCheck` batch-loads all escalation rules for the breached plans once (`slaPlanId in [...]`) and filters in-memory per ticket; `executeEscalationRules` takes the pre-loaded set. `sla.service.ts:~228-275` loops up to 1000 breached tickets, querying escalation rules + staff per ticket. **Fix:** batch-load rules by `slaPlanId` (`in`) before the loop.
- [~] **C5 — Missing indexes / N+1 config reads.** `@@index([createdAt])` on TicketAuditLog + `@@index([isEnabled, nextRunAt])` on ReportSchedule added. GIN trgm on User/Org/Staff/KbArticle + CustomField cache still TODO (next slice). Add `@@index([createdAt])` on `TicketAuditLog`, `@@index([isEnabled, nextRunAt])` on `ReportSchedule`; GIN trgm on `User.fullName`/`Organization.name`/`Staff.firstName,lastName`/`KbArticle.title,contentsText`; cache `CustomField` defs (`admin.service.ts:82,107,129` query per ticket/user read).
- **DoD:** new migration adds indexes; `make verify` green; a quick `EXPLAIN` confirms index use where added.

---

## 🟡 Batch D — MEDIUM correctness & ops

- [x] **D1 — CSP on the web app.** `next.config.mjs` `headers()` now emits a Content-Security-Policy (default-src 'self'; script/style 'unsafe-inline' — required by Next App Router inline hydration/RSC scripts, 'unsafe-eval' dev-only; connect-src locked to the NEXT_PUBLIC_API_URL origin; frame-ancestors 'none'; object-src 'none'; base-uri/form-action 'self'). Verified served on `next start`. Nonce-based script-src tightening noted as future hardening.
- [x] **D2 — Per-account login lockout.** Added `failedLoginAttempts`/`lockedUntil` to `Staff` (migration `20260525095406_staff_login_lockout`); `validateStaff` increments on wrong password, locks for `LOGIN_LOCK_MINUTES` (15, env) after `LOGIN_MAX_ATTEMPTS` (5, env), rejects while locked even with a correct password (no password verify), and clears state on success/after expiry. Lockout columns excluded from `SafeStaff`. 5 new tests in `auth.service.spec.ts`.
- [x] **D3 — Graceful shutdown.** `main.ts:65` now calls `app.enableShutdownHooks()` before `listen()`.
- [ ] **D4 — Importer hardening (`scripts/import-kayako-tickets.ts`).** (a) Wrap the per-ticket posts/notes delete+re-insert in `prisma.$transaction` (`:~113-189`) — a crash mid-loop currently loses posts. (b) `resolveType` (`:~70`) maps empty `tickettypetitle` to `Issue` instead of `null` — guard with a null check. (c) Reconcile requester: set `userId` from `UserEmail.email == requesterEmail` when a match exists (53% of imported tickets are mislinked, faithful to Kayako's bad FKs). (d) Set `hasNotes` and `lastActivityAt` from source (historical tickets currently show as "recent"). Re-run importer; psql-verify.
- [x] **D5 — EmailQueue upsert.** Added `@unique` on `EmailQueue.emailAddress` (migration `20260525115707_emailqueue_unique_email`); importer now uses an atomic `prisma.emailQueue.upsert({ where: { emailAddress } })` instead of the racy findFirst+create. Verified no existing duplicates; 19 migrations apply clean on scratch DB.
- [x] **D6 — Attachment hardening.** Added `BLOCKED_UPLOAD_EXTENSIONS` denylist + `isExtensionAllowed()` (`file-signature.util.ts`); `uploadFiles` now rejects script/executable extensions (.sh/.php/.py/.js/.bat/.ps1/.exe/.jar/...) before storage — closes the "script as text/plain passes looksTextual" gap. Tested (.php + .sh disguised as text/plain rejected). ClamAV AV-scan is explicitly **deferred** and documented inline (hook point marked in `uploadFiles`). Download already requires `TICKET_VIEW`.
- [x] **D7 — Public responses leak internal fields.** `publicCreate`/`publicReply` controllers now project the raw model to a public-safe shape (id/mask/subject/statusId/createdAt and id/ticketId/contents/isHtml/createdAt respectively) — creationMode/ipAddress/slaPlanId/staffId/email/customFields no longer reach unauthenticated callers. Covered by `tickets.controller.public.spec.ts`.
- [x] **D8 — SLA polish.** Removed the `mark_escalated` double-increment (`sla.service.ts:347` now sets only `isEscalated:true`; the level bump stays once at `:252`). SLA `@Processor('sla', { concurrency: 1, lockDuration: 120_000 })` prevents overlapping scans. Tested (`sla.escalation.spec.ts` "no double-bump"). **Deferred:** SLA pause/resume for on-hold tickets — on-hold tickets keep counting toward breach for now; tracked for a later batch (needs an `onHold`/`pausedAt` column + clock-subtraction in the breach calc).
- [x] **D9 — List endpoints + encrypted custom fields.** Added `AdminService.decryptCustomFieldsMany(scope, rows)` (one field-def lookup per page, decrypts every row in-memory) and called it in `tickets.listTickets`, `organizations.list`, `users.list` — ciphertext no longer reaches the staff UI. Tested in `admin.service.spec.ts` (batch decrypt + single-query + empty-page no-op).
- **DoD:** each fixed with a test where testable; `make verify` green.

---

## 🟢 Batch E — LOW / polish (do as time permits, group into 1–2 commits)

- [ ] **E1 — Input caps:** add `.max()` to unbounded strings/arrays — ticket `contents`, macro `replyText`, staff `signature`, `tags`, `ccEmails`/`bccEmails`, all list `search` params (`tickets/dto.ts`, `workflow/dto.ts`, `staff/dto.ts`, list query schemas). Validate `GET /tickets/my?email=` as an email (`tickets.controller.ts:~109`).
- [ ] **E2 — Auth surface:** add explicit `@Throttle` to `POST /auth/refresh`; stop returning raw `accessToken`/`refreshToken` in the login/refresh JSON body once localStorage migration is done; drop `jti`/`exp` from `GET /auth/me`; pin argon2 params explicitly.
- [ ] **E3 — Validation gaps:** Zod-validate the Alaris webhook body (`alaris.controller.ts:~38`); pre-check staff existence in `assign`/`bulkAction` assignee (`tickets.service.ts:~939,962`) and ticket existence in time-entry/follow-up create → clean 400/404 instead of opaque 500.
- [ ] **E4 — Misc:** `KbArticle` `getArticleBySlug` excludes `authorStaffId`; restrict KB `data:` img URIs to `data:image/`; `bootstrap-admin.ts` refuses `demo1234`.

---

## 📘 Batch F — Docs honesty (the recurring failure mode)

- [ ] **F1 — Tick GO_LIVE.md.** G2 (prod compose, secret gate, real origin, TLS Caddy/nginx, bootstrap admin) and G3 (`/api/health`, `db-backup.sh`+`BACKUP.md`, log rotation) are **already implemented in code** — mark them done and link the files. Run the backup→restore test to legitimately tick G3-1.
- [ ] **F2 — Write `docs/GO_LIVE_STATUS.md`** stating what is live-verified vs what still needs USER-supplied real creds/domain/cert (IMAP, MX, TLS, secrets, bootstrap creds).
- [ ] **F3 — Fix stale docs:** `FRONTEND_NOTES.md` (no mock-data fallback; middleware exists); note `AUDIT_20AGENT_2026-05-24.md` criticals are resolved. Keep `endpoints.md`/`database.md` in sync with the schema/route changes from Batches A–E.

---

## ✅ Definition of Done (whole goal)

- [ ] **Inbound email** works end-to-end against a **local** IMAP container: real email → linked client+supplier ticket pair, threaded, no dup, loop-guarded (Batch A). Real creds are the only remaining go-live step.
- [ ] All HIGH items (B, C) fixed with tests; repros fail.
- [ ] MEDIUM (D) fixed; LOW (E) as time permits; docs (F) honest.
- [ ] `make verify-full` GREEN; the real imported data (9 orgs, 339 users, 63 macros, 17 tickets) still intact (re-run the two importers after any `make reset` — see `docs/DATA_IMPORT.md`).

## ⛔ OUT OF SCOPE

- Real IMAP/`noc@` credentials, MX/DNS, TLS certificate values, production secret values, bootstrap-admin password — **🙋 USER provides at go-live.** Build + test mechanisms with local containers / placeholders.
- Multi-tenancy (single-tenant is correct if only 23T uses it — record an ADR).
- CI/CD (none by design — CLAUDE.md). Load/scale testing beyond adding the indexes above.
- Re-doing the already-fixed `AUDIT_20AGENT` "criticals" (C1–C4).
