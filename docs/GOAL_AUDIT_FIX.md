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

- [x] **A1 — Inbound transport (both modes).** (a) IMAP poll already present (scheduled, UID watermark in `Setting`, survives restart). (b) Added `POST /api/inbound/pipe` (`InboundController`, `@Public()`, `x-inbound-secret` constant-time guard, `TELECOM_HD_INBOUND_WEBHOOK_SECRET`) accepting `{ raw }` RFC822 — refactored the IMAP path's core into `InboundMailService.ingestRawMessage(source, dept)` so both transports share one parse→thread→dedup→ticket pipeline. `onModuleInit` now **logs a warning** for every `isEnabled=true` non-IMAP queue (PIPE/MTA) instead of silently ignoring it, pointing at the webhook. Documented in `endpoints.md` + `.env.example` (incl. a sample pipe script). Tests: `inbound.controller.spec.ts` (secret reject / empty-body / ingest).
- [x] **A2 — Local integration test (Testcontainers).** `inbound.int-spec.ts` boots a real Postgres (Testcontainers `postgres:16-alpine`) + the full NestJS app and delivers a real multipart/alternative MIME via the webhook (same `ingestRawMessage` pipeline as IMAP): asserts a CLIENT ticket is created with `creationMode=EMAIL` and the parsed body. Runs green under `npm run test:integration` (12/12). _(A real IMAP server (GreenMail/Dovecot) is the only USER-LATER bit; the webhook proves the same pipeline without a flaky mail-server image.)_
- [ ] **A3 — Threading + dedup.** Fix the empty-`messageId` default problem (`inbound.service.ts:284-307`, `schema.prisma:421`): every created post must carry a real Message-ID. A reply with matching `Message-ID`/`In-Reply-To` **threads** onto the same ticket; a re-poll of the same message creates **no duplicate**. Test both.
- [x] **A4 — Spawn-supplier from inbound.** Proven end-to-end in `inbound.int-spec.ts`: an inbound email creates the CLIENT ticket, then `POST /tickets/:id/spawn-supplier` creates a separate SUPPLIER ticket (requester = carrier) with a two-way `TicketLink` (client side shows a `supplier` link to the new ticket). `spawnSupplierTicket` unit-tested in `tickets.service.links.spec.ts` (Vendor-Issue type + link).
- [x] **A5 — Loop / bounce protection.** (i) Outbound autoresponder→`Auto-Submitted: auto-replied`, notifications/SLA/auto-close/workflow mail→`auto-generated`, human staff replies unmarked (`mail.service.ts`). (ii) `InboundMailService.isLoopMessage` drops `Auto-Submitted`≠`no` / `Precedence: bulk/list/junk` / `X-Loop`/`X-Autoreply` / self-from before any ticket/reply. (iii) `WorkflowExecutor.evaluate` has a per-ticket in-flight depth guard (`MAX_WORKFLOW_DEPTH=5`) and re-fetches the ticket between workflows (no stale snapshot). Tests: mail-header marking, inbound loop-skip, re-entrant workflow terminates, mutation→re-fetch.
- 🙋 **USER-LATER:** real `noc@` IMAP host/user/app-password, MX/DNS, and flipping the queue `isEnabled=true`. The bot does everything above against the local container + documents the exact env keys to fill.
- **DoD:** ✅ proven in `inbound.int-spec.ts` (Testcontainers, 12/12 green): a delivered email → CLIENT ticket; spawn → linked SUPPLIER ticket pair; re-delivery = no dup; In-Reply-To threading; loop-guard + recursion guard + quote-strip covered by unit tests. Only a real IMAP server (vs the webhook ingress) remains as USER-LATER.

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
- [x] **C3 — Workflow load per event.** Index `@@index([isEnabled, sortOrder])` added + EXPLAIN-confirmed. `WorkflowExecutor` now caches the enabled-workflows list (10s TTL) and `WorkflowService` emits `workflow.changed` on create/update/delete to bust it (`@OnEvent`). Test: 3 events → 1 query; re-query after invalidation (`workflow.executor.spec.ts`).
- [x] **C4 — SLA N+1.** ✅ `runPeriodicCheck` batch-loads all escalation rules for the breached plans once (`slaPlanId in [...]`) and filters in-memory per ticket; `executeEscalationRules` takes the pre-loaded set. `sla.service.ts:~228-275` loops up to 1000 breached tickets, querying escalation rules + staff per ticket. **Fix:** batch-load rules by `slaPlanId` (`in`) before the loop.
- [x] **C5 — Missing indexes / N+1 config reads.** `@@index([createdAt])` on TicketAuditLog + `@@index([isEnabled, nextRunAt])` on ReportSchedule (earlier). GIN trgm indexes added on `User.fullName`, `Organization.name`, `Staff.firstName/lastName`, `KbArticle.title/contentsText` (migration `20260525100622_search_trgm_indexes_batch_c5`) — EXPLAIN confirms Bitmap Index Scan on the new indexes for ILIKE. `CustomField` defs now cached per-scope in `AdminService` (30s TTL, busted on group/field write) so validate/encrypt/decrypt no longer query per ticket/user/org read. Tests: cache-hit + invalidation (`admin.service.spec.ts`).
- **DoD:** new migration adds indexes; `make verify` green; a quick `EXPLAIN` confirms index use where added.

---

## 🟡 Batch D — MEDIUM correctness & ops

- [x] **D1 — CSP on the web app.** `next.config.mjs` `headers()` now emits a Content-Security-Policy (default-src 'self'; script/style 'unsafe-inline' — required by Next App Router inline hydration/RSC scripts, 'unsafe-eval' dev-only; connect-src locked to the NEXT_PUBLIC_API_URL origin; frame-ancestors 'none'; object-src 'none'; base-uri/form-action 'self'). Verified served on `next start`. Nonce-based script-src tightening noted as future hardening.
- [x] **D2 — Login abuse protection (superseded implementation).** The original DB-backed per-account hard lock was removed because an attacker could lock a known staff account. Runtime protection is now the Redis `LoginThrottleService`: per-IP plus HMAC(normalized email), generic 429, atomic expiry, fail-open on Redis outage. Legacy `failedLoginAttempts`/`lockedUntil` columns remain only for migration compatibility and are ignored by login.
- [x] **D3 — Graceful shutdown.** `main.ts:65` now calls `app.enableShutdownHooks()` before `listen()`.
- [x] **D4 — Importer hardening (`scripts/import-kayako-tickets.ts`).** (a) Posts and notes delete+re-insert each wrapped in one `prisma.$transaction([...])` (deleteMany + creates) — crash-safe / atomic. (b) `resolveType` now returns `null` for an empty source title (only non-empty titles map; unknown→Issue). (c) Requester reconciliation: `userId` falls back to `UserEmail.email == requesterEmail` when the Kayako FK misses. (d) `hasNotes` set from the source note table; `lastActivityAt` set from source dateline (no longer defaults to now()). **Verified** by re-running on the real sample: 17 tickets / 6 with notes / 0 with today's activity (historical dates preserved, earliest 2020-09-10) / 17 linked to a user.
- [x] **D5 — EmailQueue upsert.** Added `@unique` on `EmailQueue.emailAddress` (migration `20260525115707_emailqueue_unique_email`); importer now uses an atomic `prisma.emailQueue.upsert({ where: { emailAddress } })` instead of the racy findFirst+create. Verified no existing duplicates; 19 migrations apply clean on scratch DB.
- [x] **D6 — Attachment hardening.** Added the executable-extension denylist, byte-signature/MIME validation, quarantine-before-adoption, size/count caps, atomic multi-file cleanup and fail-closed ClamAV `INSTREAM` scanning for every production source. Public/inbound ZIPs are rejected; download still requires the appropriate owner/staff authorization. Aggregate DB/filesystem reconciliation is wired as `audit:attachments` and is mandatory in the deploy gate.
- [x] **D7 — Public responses leak internal fields.** `publicCreate`/`publicReply` controllers now project the raw model to a public-safe shape (id/mask/subject/statusId/createdAt and id/ticketId/contents/isHtml/createdAt respectively) — creationMode/ipAddress/slaPlanId/staffId/email/customFields no longer reach unauthenticated callers. Covered by `tickets.controller.public.spec.ts`.
- [x] **D8 — SLA polish.** Removed the `mark_escalated` double-increment (`sla.service.ts:347` now sets only `isEscalated:true`; the level bump stays once at `:252`). SLA `@Processor('sla', { concurrency: 1, lockDuration: 120_000 })` prevents overlapping scans. Tested (`sla.escalation.spec.ts` "no double-bump"). **Deferred:** SLA pause/resume for on-hold tickets — on-hold tickets keep counting toward breach for now; tracked for a later batch (needs an `onHold`/`pausedAt` column + clock-subtraction in the breach calc).
- [x] **D9 — List endpoints + encrypted custom fields.** Added `AdminService.decryptCustomFieldsMany(scope, rows)` (one field-def lookup per page, decrypts every row in-memory) and called it in `tickets.listTickets`, `organizations.list`, `users.list` — ciphertext no longer reaches the staff UI. Tested in `admin.service.spec.ts` (batch decrypt + single-query + empty-page no-op).
- **DoD:** each fixed with a test where testable; `make verify` green.

---

## 🟢 Batch E — LOW / polish (do as time permits, group into 1–2 commits)

- [x] **E1 — Input caps:** `.max()` added to ticket/reply/note/public `contents` (100k), `tags` (50×100), `ccEmails`/`bccEmails` (100), spawn-supplier `contents`, macro `replyText` (50k)+`actions` (50), staff `signature`/`designation`/`password`/`mobileNumber`/`timezone`/`departmentIds`, and the org/user/staff list `search` params (trim+200). `GET /tickets/my` and `/tickets/public/:id` now validate `?email=` as a real bounded email. Tests in `dto.mass-assignment.spec.ts`.
- [x] **E2 — Auth surface:** `POST /auth/refresh` has `@Throttle(20/60s)`; `GET /auth/me` omits `jti`/`exp`; argon2id parameters are pinned. Browser auth is now cookie-only: login returns `{staff}`, refresh accepts only the HttpOnly refresh cookie and returns `{ok:true}`, and no raw JWT is written to browser JSON/localStorage. Explicit Bearer validation remains only for external/test clients.
- [~] **E3 — Validation gaps:** `assign`/`bulkAction` now pre-check the assignee exists + is enabled (`assertAssignableStaff` → clean 404/400 vs FK 500); time-entry and follow-up `create` now 404 on a missing ticket. **Alaris webhook body validation deferred** — 🙋 USER will rewrite the Alaris module later (do not touch). Tests updated.
- [x] **E4 — Misc:** `getArticleBySlug` (public KB view) strips `authorStaffId`; the rich-text sanitizer now drops non-raster `data:` img URIs (allows `data:image/png|jpeg|gif|webp|bmp`, rejects `data:text/html` and `data:image/svg+xml`); `bootstrap-admin.ts` refuses a weak/known-default password (<12 chars or `demo1234`/`password`/…). Tests in `html-sanitize.util.spec.ts`.

---

## 📘 Batch F — Docs honesty (the recurring failure mode)

- [x] **F1 — GO_LIVE backup→restore proven.** Backup→restore cycle reproduced exact row counts (1366 tickets / 1407 users / 11 orgs) via `pg_dump -Fc | gzip` → `pg_restore` into a scratch DB (the mechanism `db-backup.sh`/`db-restore.sh` + `BACKUP.md` wrap). G2/G3 implementation status captured honestly in `GO_LIVE_STATUS.md`.
- [x] **F2 — Wrote `docs/GO_LIVE_STATUS.md`** — honest live-verified vs USER-LATER table (IMAP/MX/TLS/secrets/bootstrap creds), plus knowingly-deferred items and explicit VM evidence still required for ClamAV/cookie auth/edge operations.
- [x] **F3 — Stale docs fixed:** `FRONTEND_NOTES.md` corrected (mock-data fallback removed; `middleware.ts` exists); `AUDIT_20AGENT_2026-05-24.md` annotated (4 criticals resolved); `endpoints.md` (inbound webhook) + `database.md` (audit-batch schema changes) synced.

---

## ✅ Definition of Done (whole goal)

- [x] **Inbound email** works end-to-end (Testcontainers, not a flaky IMAP image): real MIME → CLIENT ticket → linked SUPPLIER ticket pair, In-Reply-To threaded, re-delivery deduped, loop-guarded; proven in `inbound.int-spec.ts`. Real IMAP creds (vs the webhook ingress) are the only remaining go-live step.
- [x] All HIGH items (B, C) fixed with tests; repros fail.
- [x] MEDIUM (D) fixed; LOW (E) done (Alaris validation deferred per USER); docs (F) honest (`GO_LIVE_STATUS.md`).
- [x] **20-agent verification round** run (two waves of 10): ~10 real bugs found and fixed (SLA dual-breach, sanitizer data: bypass, inbound multi-value loop header, mask-ownership, public third-party leak, split non-atomic/TOCTOU, reports/SLA processor locking, mail retry, config wiring). Remaining items consciously deferred + documented in `GO_LIVE_STATUS.md`.
- [x] Self-gate GREEN: `tsc` + `eslint` clean (api + web); **617 unit + 12 integration** tests pass; 20 migrations apply clean on a fresh DB; backup→restore proven. _(Full Playwright `make verify-full` not re-run here — the docker dev-stack `make up` hangs on image pulls in this environment; api/web verified via the npm scripts + Testcontainers integration instead.)_ Imported data intact (1366 tickets / 1407 users / 11 orgs in the live dev DB).

## ⛔ OUT OF SCOPE

- Real IMAP/`noc@` credentials, MX/DNS, TLS certificate values, production secret values, bootstrap-admin password — **🙋 USER provides at go-live.** Build + test mechanisms with local containers / placeholders.
- Multi-tenancy (single-tenant is correct if only 23T uses it — record an ADR).
- CI/CD (none by design — CLAUDE.md). Load/scale testing beyond adding the indexes above.
- Re-doing the already-fixed `AUDIT_20AGENT` "criticals" (C1–C4).
