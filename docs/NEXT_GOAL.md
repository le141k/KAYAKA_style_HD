# NEXT-GOAL WORKLIST — post-pilot hardening (verified)

> Rewritten 2026-05-23 by the coordinator after a **15-agent skeptical verification pass**
> (each item reproduced or disproved against the live stack, not trusted). The pilot gate
> (`docs/GOAL_PILOT.md`, batches A–D) is DONE and green; this file is the next worklist.
>
> Discipline (unchanged): fix in priority order → tests → `make reset && make up && make verify`
> (or `make verify-full`) GREEN → one focused commit + push → tick done here. Never commit red.
> Keep the dev demo-seed stack working; harden only the prod profile. Demo: admin@23telecom.example / demo1234.

---

## P0 — security, fix first

### [SEC-1] 🔴 `GET /attachments/:id/download` is fully PUBLIC + unauthenticated (mass IDOR)

Verified WORSE than first reported: the route is `@Public()` with a bare `findUnique({where:{id}})` —
no auth, no ticket-scope. Anyone on the network can enumerate sequential ids and exfiltrate **every**
attachment. **Live: no token → 200 + file; agent token → 200; bogus token → 200.**

- File: `apps/api/src/modules/attachments/attachments.controller.ts:134-137` (route) → `attachments.service.ts:75-79` (`getAttachmentOrThrow`, global lookup).
- Fix: remove `@Public()`; require auth (`@RequirePermissions(TICKET_VIEW)`); scope the lookup to a ticket the requester may see (inject `@CurrentStaff`, verify assignment/department/admin); consider signed/UUID ids as defense-in-depth. (The `POST /attachments/upload/public` orphan-upload route is intentionally public — leave it.)

---

## P1 — important (honesty + auth)

### [SEC-2] No access-token revocation (no jti blocklist)

Verified REAL: `JwtAuthGuard` does only stateless verify; access tokens carry no `jti`; logout revokes
refresh tokens + clears cookies but the access JWT stays valid until its 15-min TTL. **Live: /auth/me 200 →
logout 204 → same token /auth/me still 200.** Mitigated by short access TTL + refresh IS revoked on logout.

- Files: `auth/jwt-auth.guard.ts:44-59`, `auth/auth.service.ts:159-170` (jti only on refresh), `auth.service.ts:131-137` (logout).
- Fix: add `jti` to access tokens; check a Redis blocklist (Redis already wired for BullMQ) in the guard, TTL=remaining lifetime; add the jti on logout. Optional: per-staff `tokensValidAfter` for "revoke all sessions" / disabled-staff.

### [UI-1] Client "Мои заявки" masks API errors as an empty state

Verified REAL: `useClientTickets` `catch → {data:[],total:0}` swallows errors (isError never true), and the
page only renders the "нет обращений" empty state. A 500/expired session looks like "you have no tickets."

- Files: `apps/web/lib/hooks/use-client-tickets.ts:163-176` (and `useClientTicket` :190-204 → null); `apps/web/app/(client)/tickets/client-tickets-content.tsx:18-89` (no isError branch).
- Fix: stop swallowing (keep only the empty-email short-circuit); render `<QueryError>` on isError (component exists). Same treatment for client ticket-detail.

### [UI-2] Kanban board masks API errors as empty columns

Verified REAL: `kanban-content.tsx` destructures only `{data, isLoading}` — on error renders 5 empty columns
(Batch B added `<QueryError>` everywhere except here + my-tickets).

- Files: `apps/web/app/(staff)/staff/kanban/kanban-content.tsx:11` (+ KanbanBoard empty-column render).
- Fix: read `isError`/`refetch`, add a `<QueryError>` branch (mirror tickets-list-content).

### [BUG-1] Client ticket thread duplicates the original message

Found by the client-portal verifier (not in the original list, but real): the client detail hook maps ALL
posts as replies AND renders `posts[0]` separately as the body → first message shown twice. Staff side already
uses `posts.slice(1)`.

- File: `apps/web/lib/hooks/use-client-tickets.ts:131` → `replies: t.posts?.slice(1).map(mapPostToReply)`.

---

## P2 — hardening / correctness / polish

### [SEC-3] `owner.email` leaked in public ticket payload

REAL (Medium): `getPublicTicket` selects `owner.email` → the assigned agent's internal email is returned to the
ticket's requester. Mitigated: caller must already know the requester email (per-ticket gate), so not a wide dump.

- File: `apps/api/src/modules/tickets/tickets.service.ts:285` (+ type `:44`). Fix: narrow `owner` select to `{id,firstName,lastName}`.

### [SEC-4] No per-endpoint throttle on `GET /tickets/my` and `GET /tickets/public/:id`

PARTIAL: only the global 300/60s applies. Real id-enumeration is already blocked by the email-ownership guard
(uniform 404), so this is defense-in-depth, not a live exploit.

- File: `apps/api/src/modules/tickets/tickets.controller.ts:93, 105`. Fix: add `@Throttle` (~20–30/60s) like the public POST routes.

### [OWN-1] Ownership checks have no admin/manager exception

REAL: time-entry delete + follow-up patch/delete enforce `staffId === actor` with NO `isAdmin`/permission bypass.
**Live: agent creates entry → admin (isAdmin, staff.manage) gets 403.** Over-restricts; managers can't manage the team.

- Files: `time-tracking.service.ts:37-44`, `follow-ups.service.ts:52-58` (+ controllers pass only staffId). Fix: pass `AuthStaff`; allow when `isAdmin || permissions.includes(STAFF_MANAGE)`.

### [I18N-1] Time/Follow-ups/Saved-views panels are hardcoded English (bypass i18n)

REAL: none of the three panels use `useI18n`; all labels are hardcoded English literals, so the default RU (and
UK) locale shows English in these panels. The i18n dictionaries (ru/en/uk) are healthy but have no keys for them.

- Files: `apps/web/components/tickets/{TimeTrackingPanel,FollowUpsPanel,SavedViews}.tsx`. Fix: add `timeTracking`/`followUps`/`savedViews` sections to `lib/i18n/{ru,en,uk}.ts` (ru is the type source) + wire `useI18n` (incl. aria-labels, `formatMinutes` units). (Locale-switch persistence stays OUT OF SCOPE.)

### [UI-3] Admin nav doesn't highlight the active tab

REAL: tabs carry `data-[active=true]:*` classes but `data-active` is never set (no `usePathname`).

- File: `apps/web/app/(admin)/admin/layout.tsx:82-90`. Fix: `usePathname()` → `data-active` + `aria-current="page"` (startsWith for nested routes).

### [UI-4] Kanban silently caps at 50 tickets, no warning

REAL (latent — 8 tickets now): board fetches `per_page:50`, ignores `total`, no truncation banner.

- Files: `apps/web/app/(staff)/staff/kanban/kanban-content.tsx:11` (+ KanbanBoard has no `total`). Fix: read `total`, show a banner when `total > 50` ("показаны первые 50 из N"); longer-term paginate per column.

### [BUILD-1] `multer` is a phantom (undeclared) dependency

REAL: `attachments.controller.ts:16` does a runtime `import { memoryStorage } from 'multer'` but `multer` is not
in `apps/api/package.json` — works only via hoisted transitive `multer@2.0.2` (from @nestjs/platform-express).

- Fix: add `multer@^2.0.2` (dep) + `@types/multer@^2.1.0` (devDep) to `apps/api/package.json`.

### [BUILD-2] Prod API image ships devDependencies (~1.85 GB)

REAL (api only; web standalone image is fine at 433 MB): the api Dockerfile copies the full build-stage
`node_modules` (with vitest/playwright/eslint/tsc/prisma/testcontainers) into the runner.

- File: `apps/api/Dockerfile:11,15,23`. Fix: add a `prod-deps` stage (`npm ci --omit=dev`), copy THAT into the runner; carry over the generated Prisma client (`.prisma`/`@prisma/client`).

---

## Verified GOOD (do not re-open)

- **Client portal** end-to-end: submit (priority urgent→Urgent correct), my-tickets-by-email, detail/reply, resolved→reopen, KB list/search/article — all PASS (except [BUG-1]).
- **Kanban** functionally works: renders 5 columns, drag→`PATCH /tickets/:id/status` persists, click→detail. (Polish: onDragLeave flicker, no optimistic-rollback on PATCH failure — P3.)
- **SLA is NOT 24/7** (claim disproven): the seeded "Standard Business Hours" schedule (Mon–Fri 09:00–18:00) is wired and `computeDueDates`/`addWorkingSeconds` honor it; the API fully supports `workHours` writes. Only the admin **working-hours editor UI** is missing — an explicit **Phase-3 / OUT OF SCOPE** item, not a pilot blocker (hours are settable via API meanwhile).

## ⛔ OUT OF SCOPE (post-pilot — do not touch)

i18n switch persistence; kanban onDragLeave flicker / optimistic rollback; CommandPalette eager fetch; KB
category draft count; Radix DialogDescription a11y; sub-department deep nesting. Parity (CF options editor, POP3,
SLA working-hours **editor UI**, saved-view date-range, CC/BCC, KQL breadth) = Phase 3. Multi-tenant/load/backup/OTel = Phase 2.
