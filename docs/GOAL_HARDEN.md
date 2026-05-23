# GOAL — Pilot polish & harden (autonomous)

Run: `/goal docs/GOAL_HARDEN.md`. Close the **security / safety / polish tier** found in the pilot
acceptance audit (full item list with verdict · severity · file:line · fix is in `docs/NEXT_GOAL.md`,
rewritten at commit 31add8e). After this, the product is honestly hand-to-a-real-team ready.
**Execute batches IN ORDER. Self-gate after every batch — do NOT wait for external review between them.**

## Operating rules (EVERY batch)

1. Take ONE batch (smallest coherent slice). Write/extend a test for each fix.
2. **Self-gate:** `make reset && make up && make verify` MUST be green (reseed → tsc · vitest · build · lint · smoke). Never commit red.
3. Security fixes MUST be **live-verified** (curl/e2e), not just code: the bug's repro must now fail.
4. One focused commit + push per batch. Tick it done here. Move on.
5. Keep the DEV stack working (demo seed, http) — `make verify` depends on it. Harden only the prod profile.
6. Do NOT touch "OUT OF SCOPE". Don't gold-plate.
7. STOP when all batches done AND the Definition of Done below is green; then run `make verify-full` once more and post a final summary.

---

## ✅ Batch H1 — Security (DONE)

- [x] 🔴 **SEC-1** download route no longer `@Public()` → `@RequirePermissions(TICKET_VIEW)`. **Live: no-token → 401, bogus → 401, admin → 200** (was 200 for anyone). Client portal renders no attachment links, so no regression. (`attachments.controller.ts`)
- [x] **SEC-2** Redis jti-blocklist (`TokenBlocklistService`, fail-open) — access tokens carry a `jti`; `JwtAuthGuard` rejects revoked jtis; logout blocks the current access jti for its remaining TTL. **Live: me 200 → logout 204 → me 401.**
- [x] **SEC-3** `getPublicTicket` owner select dropped `email` → `{id,firstName,lastName}`. **Live: owner has no email.**
- [x] **SEC-4** `@Throttle` on `GET /tickets/my` + `GET /tickets/public/:id` (env-driven `PUBLIC_READ_LIMIT`, default 30; dev=100 for e2e).
- **Acceptance:** all repros blocked live; api vitest 507/507 (+ guard revocation, blocklist, public-owner specs); `make verify` GREEN 9/9. ✅

## ✅ Batch H2 — Safety / correctness (DONE)

- [x] **UI-1** `useClientTickets` no longer swallows errors (kept only the empty-email short-circuit); `client-tickets-content` renders `<QueryError onRetry>` on isError.
- [x] **UI-2** `kanban-content` reads `isError`/`refetch` → `<QueryError>` branch (no more empty columns on failure).
- [x] **BUG-1** client mapper `posts.slice(1)` — original message no longer duplicated.
- [x] **OWN-1** time-entry/follow-up delete+patch accept a `canManageOthers` flag (`isAdmin || STAFF_MANAGE`) computed in the controllers. **Live: admin DELETE agent's /time → 204, /follow-ups → 200** (was 403).
- **Acceptance:** client/kanban surface real errors; thread shows each post once; admin manages any time/follow-up; api vitest 509/509; `make verify` GREEN. ✅

## ✅ Batch H3 — Polish / i18n (DONE)

- [x] **I18N-1** Added `timeTracking`/`followUps`/`savedViews` sections to ru/en/uk dicts (ru = type source → en/uk completeness compile-enforced); all three panels wired through `useI18n`. **Live: panels render Russian, no stray English.**
- [x] **UI-3** Admin nav active tab via `usePathname` → `data-active`/`aria-current`. **Live: open tab "Отделы" highlighted.**
- [x] **UI-4** Kanban reads `total`; banner "Показаны первые 50 из N" when `total > 50` (latent now at 8 tickets).
- **Acceptance:** RU panels localized; active tab visible; kanban warns when capped; `make verify` GREEN. ✅

## ✅ Batch H4 — Build hygiene (DONE)

- [x] **BUILD-1** Added `multer@^2.0.2` (dep) + `@types/multer` (devDep) to apps/api; also moved `prisma` + `pino-pretty` to dependencies (both needed at runtime: prisma for `migrate deploy`, pino-pretty for the dev container's `NODE_ENV=development` pretty logs).
- [x] **BUILD-2** New `prod-deps` stage (`npm ci --omit=dev`); runner copies that node_modules + the build-stage generated Prisma client. **vitest/eslint/testcontainers gone from the runtime image; api boots, migrate+seed run, upload → 201.** Image 1.85 → 1.59 GB. (Residual tsc/playwright are hoisted transitive prod deps of the workspace; the test toolchain itself is removed.)
- **Acceptance:** api boots under --omit=dev; upload works; `make verify` GREEN. ✅

## ✅ Batch H5 — Security follow-up (DONE — found auditing committed H1)

- [x] 🔴 **SEC-3b** `getPublicTicket` pulled `posts` with **no select** → staff `email` + `ipAddress` + `staffId` leaked to the client. Added a narrow `select` (id, ticketId, authorType, userId, fullName, contents, isHtml, createdAt, attachments{id,fileName,size,mimeType}) + a `PublicTicketPost` type. **Live: post keys = [attachments,authorType,contents,createdAt,fullName,id,isHtml,ticketId,userId]; email/ipAddress/staffId absent.**
- [x] 🔴 **SEC-5** `POST /attachments/upload/public` now `@Throttle`d (`PUBLIC_UPLOAD_LIMIT`, default 5/60s). **Live: 3×201 → then 429.**
- [x] 🟠 **SEC-1b** Client cannot download its own attachments today (portal renders no download links). → **Documented as Phase 2** (owner/email-scoped public download). No code now.
- [x] 🟠 **SEC-6** `linkToPost` orphan-adoption IDOR closed: anonymous uploads bind to a per-upload `claimToken` (client-generated UUID, one per submit session, sent as a form field; server validates/mints). Adoption requires the matching token, then clears it (no replay). Staff path (authenticated) unchanged. **Live: matching token → attachment adopted; wrong token → adopted set EMPTY.** New nullable `Attachment.claimToken` column + migration.
- [x] 🟠 **SEC-2b** jti blocklist stays fail-open but now emits a **throttled ERROR** ("Redis unreachable, fail-open BYPASS active") so the revocation-bypass window is observable (alert/metric hook); ≤1 log / 30s to avoid flooding.
- **Acceptance:** all 4 security repros blocked live; api vitest +6 (controller throttle/claimToken, linkToPost token-scope, uploadFiles token, public-posts select); `make verify` GREEN 9/9; e2e 37/37. ✅

## ✅ Batch H6 — Polish quick-wins (DONE — from second acceptance pass)

- [x] 🟡 **UI-5** Kanban cap banner + page strings were hardcoded RU → added `kanbanPage` i18n section (ru/en/uk) with a `{shown}/{total}` interpolated `cap`; wired the page through `useI18n`.
- [x] 🟡 **UI-6** Staff user-menu "Профиль" pointed at `/admin/staff` (dead link for agents; no profile page exists) → dropped it; "Настройки" → `/admin` now gated behind `user.role === 'admin'`.
- [x] 🟡 **SEC-7** `StorageService.createReadStream`/`delete` now resolve the storageKey and assert it stays inside the upload dir (defense-in-depth path-traversal guard; storageKeys are DB-sourced). +4 unit tests.
- **Acceptance:** `make verify` GREEN 9/9; e2e 37/37. ✅

## ✅ Batch H7 — Admin workflow/macro builders (DONE — real feature gaps)

- [x] 🟠 **ADM-1** Macro dialog now has an **actions builder** (field-array). `macroSchema` gained `actions`; create/edit serialize them to `{type,value}` (no longer `[]`/preserve-only). Uses a macro-aligned `MACRO_ACTION_TYPES` (only types `applyMacro` executes). Backend: `applyMacro` `add_tag`/`add_note` now accept the UI's generic `value` (not just typed `tag`/`note` keys). **Live: macro `{add_tag, value:'h7tag'}` created via API → applied → ticket tagged `h7tag`.** +2 unit tests.
- [x] 🟠 **ADM-2** Workflow criterion _field_ is now a **dropdown** of real ticket columns (`CRITERION_FIELDS`: subject/statusId/priorityId/departmentId/typeId/ownerStaffId/requesterEmail/creationMode/flagType/isResolved/isEscalated) — admin can no longer silently save a rule referencing a non-existent field.
- **Acceptance:** UI-built macro fires live; criterion field constrained to real columns; api vitest 56/56 in the macro suite; `make verify` GREEN 9/9; e2e 37/37. ✅

---

## ✅ Definition of Done — ALL GREEN

- [x] Every NEXT_GOAL P0/P1/P2 item above is fixed with a test (H1–H4 committed).
- [x] SEC-1..4 **live-verified**: anon/bogus attachment download → 401 (admin 200); logout → access token 401 (jti blocklist); public ticket owner has no email; @Throttle on /tickets/my + /public/:id.
- [x] No silent error-masking: client my-tickets + kanban now render `<QueryError>` on failure (BUG-1 dup-message also fixed).
- [x] `make verify-full` GREEN — gate 9/9 + e2e 37/37, vitest 509/509.
- [x] Dev loop works (demo seed + make verify green); prod profile builds (helmet, secret-gate, no demo seed, devDeps pruned, behind reverse-proxy).
      → tagged `v1.0-pilot`.

## ⛔ OUT OF SCOPE (do NOT touch — post-pilot)

SLA working-hours editor UI (schedule IS applied — confirmed; only the editor is missing = Phase 3). **Client-portal attachment download (SEC-1b)** — the client portal renders no download links today, so there is no live exposure; an owner/email-scoped public download (mirroring `GET /tickets/public/:id`) is **Phase 2**. Multi-tenancy, full OTel/metrics, DB backups, load test, real-SMTP/bounce, CI/CD = Phase 2. i18n switcher persistence, CommandPalette eager fetch, Radix DialogDescription a11y, KB category draft count = deferred polish.
