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

## ☐ Batch H4 — Build hygiene

- [ ] **BUILD-1** `multer` is a phantom (imported, not a direct dep). **Fix:** add `multer` + `@types/multer` to `apps/api/package.json`.
- [ ] **BUILD-2** Prod API image ships devDeps (~1.85 GB). **Fix:** `npm ci --omit=dev` (or prune) in the runner stage of `apps/api/Dockerfile`.
- **Acceptance:** `docker compose -f docker-compose.prod.yml build` succeeds; image slimmer; `make verify` green.

---

## ✅ Definition of Done — STOP when ALL green

- [ ] Every NEXT_GOAL P0/P1/P2 item above is fixed with a test.
- [ ] SEC-1..4 **live-verified** (anon attachment download blocked; logout revokes access; no owner email in public ticket; throttle present).
- [ ] No silent error-masking anywhere (client my-tickets + kanban show real errors).
- [ ] `make verify-full` green (gate 9/9 + full e2e), stable.
- [ ] Dev loop still works; prod profile still builds.
      → then tag `v1.0-pilot`.

## ⛔ OUT OF SCOPE (do NOT touch — post-pilot)

SLA working-hours editor UI (schedule IS applied — confirmed; only the editor is missing = Phase 3). Multi-tenancy, full OTel/metrics, DB backups, load test, real-SMTP/bounce, CI/CD = Phase 2. i18n switcher persistence, CommandPalette eager fetch, Radix DialogDescription a11y, KB category draft count = deferred polish.
