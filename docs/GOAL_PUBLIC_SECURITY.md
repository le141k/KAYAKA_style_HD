# GOAL — Security fixes before public access

_Created: 2026-07-16. Status updated 2026-07-17: **CODE COMPLETE; PUBLIC GO-LIVE STILL
BLOCKED ON VM/EDGE EVIDENCE**. Cookie-only staff/client auth, signed CSRF, abuse quotas, Turnstile,
disk-backed quarantine, fail-closed ClamAV, bounded cleanup, identity/message-id migrations and the
internal-only deploy/backup/Redis recovery orchestration are implemented and locally gated. The
remaining work is operational: credential cutover, live data audits, restore/Redis rehearsal,
scanner/EICAR/load proof, real proxy-IP/firewall checks, HTTPS smoke and staged soak. Keep the portal
private until the Definition of Done is green._

Run later as an implementation goal: `/goal docs/GOAL_PUBLIC_SECURITY.md`.

> **Historical integration baseline (`claude/helpdesk-security-integration`).** The security work was merged
> onto the then-current `origin/main` (RBAC/Manager, session revocation, last-admin guard, inbound
> webhook, D2 login lockout, mail retry). A review pass
> then closed these gaps: **#3** `ClientPortalGuard` now fail-closes the ENTIRE client surface in
> prod (request-link/verify/list/detail/reply/download → 404 unless enabled; verified live 404↔202);
> **#5** `User.isEnabled` enforced at link issuance + session resolution; **#6** SMTP-retry
> (`throwOnError`) preserved with a regression test; **#7** a staff security change (admin reset /
> disable / logout-all) now burns pending password-reset links, and reset rejects a disabled staff;
> plus a per-owner magic-link mail-bomb cap, `audit:ownership` non-zero exit on NOT-CLEAN, and the
> web `fileName` fix. The current release candidate adds the later S4/auth/deploy closure; historical
> numeric test counts are deliberately omitted because the final release gate must be attached to
> the exact commit being deployed.

This plan closes the security bugs found during the 2026-07-16 read-only review. The portal must
remain behind the current CIDR/Tailscale restriction until the full Definition of Done is green.

> **Historical S1 progress (2026-07-16 — `claude/helpdesk-security-workflow-rycs0y`).** Landed the
> local, non-breaking S1 secret-leakage core with tests:
>
> - **S1-1/S1-2** strict-allowlist HTTP logging (`apps/api/src/config/logging.ts`) + a
>   log-secrecy regression test (`logging.spec.ts`).
> - **S1-3** fixed the reset-mail DI: the dead `MAIL_SERVICE_TOKEN: undefined` placeholder (which
>   silently disabled reset mail and forced the raw-URL dev log in **every** environment) is gone;
>   `AuthModule` now imports `MailModule` and binds the real `MailService`.
> - **S1-4** fail-safe reset dispatch — `MailService.sendTemplateStrict` throws on enqueue/send
>   failure; `forgotPassword` invalidates the issued token on failure, never logs the raw link, and
>   the `password_reset` template is provisioned in production via migration
>   `20260716000000_password_reset_template`.
> - **S1-5** atomic single-use reset consume (conditional `updateMany`, affected-row count must be
>   one) + token delivered in a URL **fragment**; the reset page strips it with `replaceState` and
>   sets `Referrer-Policy: no-referrer`.
>
> _(Historical snapshot from the S1 landing — see the status line at the top of this file for the
> current picture.)_ **Since then:** S2 (verified client sessions, backend + frontend cutover), S3
> (staff-session correctness, CSRF-origin, login throttle) and S5-7 (preflight/boot guards) have all
> landed with tests. **Since this historical snapshot:** S1-6/1-7 and the S3-5 token layer are
> implemented; S1-8 has browser coverage awaiting live execution. S4 and client-cookie code are now
> implemented; S0 / S1-9 / S5-edge / S6 live proof remains VM-owned.

## Scope decision

### In scope now

- credential, reset-token, cookie and JWT leakage;
- client-ticket ownership (replace “knowing an email” with a verified client session);
- immediate staff-session invalidation, refresh rotation and CSRF protection;
- anonymous upload/spam/storage abuse controls;
- production edge, real client IP, firewall, secret isolation and safe logging;
- production preflight, demo-account guard, runtime patching and staged rollout.

### Explicitly out of scope

- **Google / OIDC / OAuth login** — implement only after this goal is complete;
- multi-tenancy, unrelated product work, SLA/UI polish and broad refactors;
- a business rewrite of Alaris (unused public ingress is still blocked in this goal);
- CI/CD (this repository intentionally uses local gates).

Do not add Google client IDs, OAuth dependencies, callback routes or login buttons in this goal.

## Why order matters

Primary dependency chain:

`S0 containment → S1 secret-safe auth → S2 verified client session → S4 public abuse controls → S5 edge → S6 release`

`S3 staff sessions + CSRF` starts only after S1 and may run alongside S2. S2 depends on S1 because
magic-link tokens must never enter logs and password-reset mail delivery must already be reliable.

## Immediate hotfix lane — do this now

This is the shortest safe lane while the portal remains private. It maps to the detailed batches
below; it is not a second implementation. Local S1 code/tests can start immediately, while S0 backup
and inventory are completed before any production mutation or migration.

- [ ] **H0 Keep ingress private:** preserve the allowlist, stop any Quick Tunnel, and prove the old
      `trycloudflare.com` URL no longer serves the application.
- [ ] **H1 Stop secret leakage:** complete S1 logging, reset-mail, reset-race and cookie-only fixes;
      deploy redaction and verify it before rotating any affected secret.
      _(Code done: logging redaction, reset-mail DI/fail-safe, authVersion-stamped reset transaction,
      cookie-only login/refresh and exact cookie clearing. Runtime browser proof and S1-9 secret
      rotation remain.)_
- [ ] **H2 Close the client IDOR:** API fail-closes list/detail/reply and client attachment access;
      temporarily hide/disable those UI actions until the verified client-session flow is complete.
      Untrusted public attachment upload stays disabled until S4 is green.
      _(Done on the API: my/detail/reply now require a verified client session (S2-6/7) bound to
      `Ticket.userId`, and the owner-scoped client attachment download route is in place (S2-8);
      public create + upload stay fail-closed 404 in prod (S2-1). The UI cutover (S2-9) is also in:
      the old email-only lookup is removed and the portal uses the magic-link session, attachments
      point at the owner-scoped route. Only the browser e2e round-trip remains (S2-10/S6).)_
- [ ] **H3 Close staff-auth gaps:** use DB-backed `authVersion`, logout-all revocation, atomic refresh
      rotation and origin + CSRF checks for every cookie-authenticated mutation.
      _(Done: DB-backed `authVersion` + logout-all revocation (S3-1/2/4), atomic refresh rotation by
      jti/familyId (S3-3), exact-origin + signed double-submit CSRF via `CsrfGuard` (S3-5), and the
      login-abuse throttle (S3-7 — per-IP + HMAC(email) Redis throttle, generic 429, fail-open, no
      account lock). Staff and client production cookies use `__Host-` names at `Path=/`.)_
- [ ] **H4 Remove known access paths:** soft-disable demo staff, revoke their sessions, then rotate JWT
      and webhook secrets in the order defined by S1. Never delete staff rows as containment.
- [ ] **H5 Deploy privately and smoke:** use immutable images/config, run the mandatory production
      smoke suite behind the allowlist, and keep the world-public launch blocked until S0–S6 pass.

## Operating rules

1. Execute batches in order and keep the public CIDR allowlist in place through S6.
2. Reproduce every bug first; add a regression test; prove the old repro fails after the fix.
3. Use the smallest coherent diff. One focused commit per numbered batch.
4. Never print secrets, cookies, authorization headers, reset links or magic-link tokens.
5. Preserve the dev profile and demo seed. Production alone must reject demo credentials/data.
6. Update `docs/api/endpoints.md`, `docs/database.md`, `docs/architecture.md` and the relevant runbook
   in the same commit when an endpoint, model, auth flow or deployment contract changes.
7. Ask before:
   - adding npm/system/container dependencies (Turnstile integration package, ClamAV, scanner, etc.);
   - changing DNS, firewall, NAT, Cloudflare, production env or runtime image versions;
   - disabling live accounts, rotating secrets/sessions, deleting logs or running a restore;
   - running heavy `make reset`, image rebuilds or the full end-to-end gate.
8. No production mutation without a fresh DB + uploads backup and a written rollback step.

---

## 🔴 S0 — Immediate containment and live inventory

Read-only inspection comes first. Local S1 implementation may proceed in parallel, but no live data
mutation, migration or credential rotation starts until the backup/inventory prerequisites below are
recorded; state-changing operator actions require explicit approval.

- [ ] **S0-1 Keep the portal private.** Preserve `HELPDESK_ALLOWED_CIDRS`; verify a source outside the
      allowlist gets no application access. Do not set `0.0.0.0/0` and do not expose the origin by
      direct NAT while remediation is underway. Files: `.env.public`,
      `infra/caddy/Caddyfile.public`, `infra/helpdesk-edge-nat.sh`.
- [ ] **S0-2 Find and stop temporary exposure.** Read-only check for running `cloudflared` Quick
      Tunnels, stale public URLs and unexpected listeners. If a Quick Tunnel is active, obtain
      approval, stop it and record the exposure window. Verify the previously issued
      `trycloudflare.com` URL no longer serves the app. Quick Tunnels are not a production edge.
- [ ] **S0-3 Take recoverable backups.** Back up PostgreSQL and the uploads volume, copy both off-host,
      and prove a restore into a disposable database/volume. Follow `docs/BACKUP.md`; never test a
      restore against production.
- [ ] **S0-4 Decide evidence retention before copying logs.** If incident review requires preservation,
      make one restricted, encrypted copy of the minimum exposure window and inspect it for demo
      logins, reset requests, refresh reuse and unknown administrator activity. Otherwise do not create
      another copy of leaked credentials. Never paste raw lines into docs/issues/chat; deletion or
      truncation is a separate approved operation.
- [ ] **S0-5 Inventory live identities and sessions.** On the VM, count enabled staff/admin accounts,
      active refresh tokens and unused password-reset tokens. Check every enabled staff password hash
      against every shipped/default demo password, not only two known email addresses. Record counts
      only. Verify that at least one real enabled administrator will remain.
- [ ] **S0-6 Contain demo identities.** After approval, soft-disable known/demo staff records, revoke
      refresh tokens and invalidate password-reset tokens. Once S3 is deployed, also increment their
      auth version. Preserve rows for FK/audit history and do not alter the dev seed. Review
      audit/last-login timestamps first; the S1 JWT cutover invalidates any still-live pre-S3 access
      token.
- [ ] **S0-7 Restrict secret-file permissions.** After approval, change live `.env.prod`, `.env.public`
      and `secrets.md` from the observed `0644` to owner-only `0600`, confirm ownership, and ensure
      backups/copies are equally restricted. S5 adds a permanent preflight guard.

**S0 acceptance**

- the application is still reachable only through the approved private/allowlisted path;
- a fresh DB + uploads backup has passed a disposable restore;
- the live account/session inventory is recorded without exposing secrets;
- no enabled production staff account uses a shipped/demo credential;
- the old Quick Tunnel URL does not serve the app and secret files are not group/world-readable.

---

## 🔴 S1 — Stop credential and token leakage

This batch must deploy before creating any new magic-link/session secret.

- [x] **S1-1 Switch HTTP logging to a strict allowlist.** Configure `pino-http` in
      `apps/api/src/app.module.ts` to retain only method, route/path without query, status, duration,
      request ID and trusted client IP. Redact/drop every request/response header by default, including
      `Cookie`, `Authorization`, `Set-Cookie`, `Proxy-Authorization`, API-key headers,
      `X-Inbound-Secret` and `X-Alaris-Secret`, in every case/array shape. Do not log bodies.
      _(Done: `apps/api/src/config/logging.ts` — strict serializers + `redact … remove`.)_
- [x] **S1-2 Add a log-secrecy regression test.** Exercise login, refresh, authenticated API access,
      inbound/Alaris webhooks, forgot-password and reset-password with unique sentinel values. Assert
      captured structured output contains none of the sentinels, raw headers, cookies, bearer tokens,
      passwords, requester-email queries or URL tokens.
      _(Done: `apps/api/src/config/logging.spec.ts`.)_
- [x] **S1-3 Fix password-reset mail DI.** Remove the local
      `MAIL_SERVICE_TOKEN = undefined` provider from `apps/api/src/auth/auth.module.ts`. Preferred
      implementation: import the exported mail provider and inject `MailService` directly. If the
      existing mail/ticket module cycle blocks that, extract a narrow acyclic reset-mail adapter;
      never restore an `undefined` placeholder provider.
      _(Done: `AuthModule` imports `MailModule` and binds `MAIL_SERVICE_TOKEN` to the real
      `MailService`. Verified acyclic — nothing in MailModule's subtree imports the @Global AuthModule.)_
- [x] **S1-4 Make reset-mail dispatch explicit and fail safe.** Production must never log a reset
      URL/token. Create only a hashed token, call a security-mail method that throws when enqueue/send
      fails, and atomically invalidate the token on failure. Return the same generic response to avoid
      enumeration. Provision the production reset template via migration/idempotent upsert because the
      production seed does not run. A dev diagnostic may identify the failure, never the raw link.
      _(Done: `MailService.sendTemplateStrict` (throws); `forgotPassword` invalidates on failure;
      migration `20260716000000_password_reset_template`.)_
- [x] **S1-5 Make password-reset consumption atomic.** Replace find-then-update with a conditional
      consume (`usedAt IS NULL`, not expired) whose affected-row count must equal one before changing
      the password. Add concurrent replay coverage. Deliver the reset token in a URL fragment; the UI
      removes it immediately with `history.replaceState`, POSTs it in the body and uses
      `Referrer-Policy: no-referrer`.
      _(Done: PasswordReset is stamped with issue-time `authVersion`; one transaction consumes the
      live token and conditionally updates only an enabled, version-matched Staff row before revoking
      sibling reset/refresh tokens. Admin disable/password/logout races therefore fail closed.
      Fragment delivery + `replaceState` + `referrer: no-referrer` remain in the reset page.)_
- [x] **S1-6 Make browser auth cookie-only.** `POST /api/auth/login` returns only the safe staff
      principal; refresh returns a non-secret success shape. Remove refresh-token body DTO fallback
      after inventorying real non-browser consumers. Update web types/hooks, API tests, diagnostics,
      e2e, `scripts/smoke.sh`, docs and any screenshots/audit scripts that parse token JSON. If machine
      tokens are required, design a separate scoped flow.
      _(Done: login returns `{staff}`, refresh is cookie-only and returns `{ok:true}`; the body-token
      DTO fallback and frontend token types are removed. Bearer validation remains only for explicit
      external/test compatibility; browser code never receives a JWT.)_
- [x] **S1-7 Define and clear cookies exactly.** Use host-only secure cookies with no `Domain`.
      Production access and refresh cookies use the `__Host-` prefix and therefore `Path=/`; keep
      session cookies `HttpOnly` and clear every current and legacy name/path during cutover.
      _(Done: production uses Secure/HttpOnly host-only `__Host-th_access` and
      `__Host-th_refresh`, both at `/`. Refresh-only hard navigations can recover through `/auth/me`.
      Logout and every handler-level refresh failure clear current and legacy names/paths, including
      the former `__Secure-th_refresh` at `/api/auth/refresh`.)_
- [~] **S1-8 Prove XSS cannot read a refreshed token.** From browser-context integration/e2e tests,
  call refresh and assert the response body contains no access/refresh token while cookies rotate.
  _(Browser-context assertions were added to `e2e/auth.setup.ts` for login/refresh JSON and
  HttpOnly cookies; execution against the live stack remains part of the S6 gate.)_
- [ ] **S1-9 Perform the credential cutover in safe order.** First deploy redaction and prove it at
      runtime. Then, with approval and sender coordination, revoke refresh/reset tokens and rotate both
      JWT secrets plus inbound and Alaris webhook secrets. Verify old values fail. Rollback may restore
      code/images, never old secrets. Do not blindly rotate DB, Redis or field-encryption keys.

**S1 acceptance**

- runtime log probes contain no auth/webhook/API-key header, cookie, password, reset token or
  requester-email query value;
- a real forgot-password request queues an email and the raw link appears nowhere in production logs;
- concurrent use of one reset token changes the password exactly once;
- login/refresh JSON contains no JWT; cookie rotation and logout still work;
- all pre-cutover sessions/reset links and old JWT/webhook secrets are invalid.

---

## 🔴 S2 — Replace “email as password” with a verified client session

Current public list/detail/reply routes must not be exposed until this batch is complete.

> **Progress.** The client-session implementation is code-complete: normalized unique ownership,
> hashed magic-link/session persistence, generic asynchronous request-link responses, atomic
> single-use verification, revocation/versioning, stable `User.id` authorization, owner-scoped
> ticket/reply/download routes, the client UI cutover and expiry cleanup. Production cookies use
> `__Host-th_client` at `Path=/`. The remaining S2 evidence is the full browser/mail round trip and
> cross-client HTTP matrix on the deployed allowlisted stack; the production gate remains closed
> until that evidence is green.

- [x] **S2-1 Add a fail-closed interim gate.** While S2 is incomplete, production must return 404/503
      for `GET /api/tickets/my`, `GET /api/tickets/public/:id`, client attachment download and
      `POST /api/tickets/public/:id/reply`. Remove/hide matching reply, upload and download UI actions.
      Keep public ticket creation only after S4. The API gate defaults closed in production and does
      not depend on frontend behavior.
      _(Done: `ClientPortalGuard` returns 404 in production across request-link/verify/session,
      ticket list/detail/reply/download and client/public upload surfaces unless the corresponding
      feature gates are enabled. The frontend uses only the verified-session routes.)_
- [x] **S2-2 Establish one stable ownership identity before migrating.** Audit and normalize
      `UserEmail`, reject/fix case-insensitive duplicates, and enforce a DB-level normalized-email
      uniqueness invariant. Backfill `Ticket.userId` only when one normalized email maps to exactly one
      user; ambiguous or unlinked tickets remain inaccessible and enter a manual-resolution report.
      _(Done: `normalizeEmail` (trim+lowercase) is canonical in `common/email.util.ts`; every
      `UserEmail` read/write in `UsersService` (`findByEmail`/`findOrCreate`/`create`/`addEmail`) — and
      thus ticket-create + inbound-mail, which route through `findOrCreate` — now normalizes, so new
      data stays clean. Migration `20260716180000_normalize_user_email_ownership` normalizes existing
      non-colliding rows and backfills `Ticket.userId` **only** where a normalized email maps to exactly
      one user; ambiguous/unlinked tickets are left untouched. The **manual-resolution report** is
      `npm run audit:ownership -w apps/api` (READ-ONLY): it lists case-insensitive duplicate groups
      (flagging ambiguous >1-user ones), still-un-normalized rows, and ambiguous/orphan unlinked
      tickets, with a `clean` gate. Verified live against Postgres (rolled back): non-colliding
      normalized, ambiguous ci-dup left as-is, unambiguous ticket backfilled, ambiguous+orphan tickets
      not backfilled, audit classifies all correctly. Migration
      `20260717000000_client_identity_invariant` now fails before mutation unless that audit is clean,
      re-runs the unambiguous ticket backfill, adds the normalized-email check and unique expression
      index, and invalidates pre-version client auth material. The live production audit/remediation
      remains a VM gate, not deferred code.)_
- [x] **S2-3 Add client-auth persistence.** Add Prisma models/migration for a single-use hashed login
      token and a hashed client session. Both require a non-null stable `userId`; normalized email is an
      audit snapshot, never the authorization key. Include expiry, `usedAt`/`revokedAt`, created and
      last-seen fields. Store only SHA-256/HMAC hashes of cryptographically random tokens, index active
      lookup/expiry and never persist the raw token.
      _(Done, commit `ecbec7b`: `ClientLoginToken` + `ClientSession` models (migration
      `20260716165721_client_auth`), both keyed on non-null `userId`, `tokenHash` unique, `email` as an
      audit snapshot, `usedAt`/`revokedAt`/`expiresAt`/`lastSeenAt`. Only SHA-256 hashes of 32-byte
      random tokens are stored; the raw token is never persisted.)_
- [x] **S2-4 Implement request-link.** Add a public, tightly throttled endpoint that accepts an email,
      normalizes it, always returns the same 202 response, invalidates older unused tokens and queues
      a short-lived link only when the address maps unambiguously to one `userId` that owns at least one
      ticket. Bind the token to that `userId`. Key limits by trusted client IP and HMAC(normalized
      email); do not expose account existence.
      _(Done, commit `ecbec7b`: `POST /api/client-auth/request-link` (`@Public`, `@Throttle 3/60s`)
      normalizes the email, always returns the same 202 body, `resolveUnambiguousOwner` issues a
      15-min token bound to `userId` ONLY when exactly one user owns ≥1 ticket (ambiguous/unknown/
      no-ticket → silent no-op), and invalidates older unused tokens first. Unit-tested for the
      one-user, ambiguous, unknown and no-ticket branches.)_
- [x] **S2-5 Keep the magic token out of proxy logs.** Preferred browser flow:
      `/verify#token=<raw>` → client JS immediately removes the fragment with
      `history.replaceState` → POSTs the token in a non-logged body to a verify endpoint. The API
      atomically consumes the single-use token, creates a client session and sets an `HttpOnly`,
      `Secure`, host-only cookie. Set `Referrer-Policy: no-referrer` on the verification page.
      _(Done: the emailed link is `…/verify#token=<raw>` (fragment, so the token never reaches
      proxy/access logs); `POST /api/client-auth/verify` reads the token from the request BODY,
      atomically single-use-consumes it (conditional `updateMany` on `usedAt IS NULL AND not expired` →
      exactly one winner) and sets an `HttpOnly`, `Secure`, host-only production
      `__Host-th_client` cookie at `Path=/` (development uses `th_client`). The `/verify` page reads
      the `#token=` fragment, strips it
      with `history.replaceState`, and is rendered with `referrer: no-referrer`. Path corrected
      `/client/verify` → `/verify` to match the `(client)` route group.)_
- [x] **S2-6 Add an explicit client auth mode.** Implement `@ClientAuthenticated()` metadata/decorator
      and guard composition so the global staff JWT guard cannot block client routes and `@Public()`
      cannot accidentally expose them. Resolve the session to a client principal containing `userId`,
      reject expired/revoked sessions, and add logout/revocation. Do not reuse staff JWT/RBAC identity.
      _(Done, commit `ecbec7b`: `@ClientAuthenticated()` = `applyDecorators(Public(), UseGuards(
ClientAuthGuard))`; `ClientAuthGuard` resolves the `th_client` cookie to `{ userId }` via
      `resolveSession` (rejects expired/revoked → 401, fails CLOSED 503 on store outage), and
      `@CurrentClient()` exposes the principal. `logout` revokes the session. No staff JWT/RBAC
      identity is reused. Guard unit-tested (no cookie → 401, invalid → 401, valid → attaches
      `req.client`, store outage → 503).)_
- [x] **S2-7 Remove caller-controlled ownership.** Client list/detail/reply services authorize only by
      `Ticket.userId === client.userId`; remove `?email=` and `requesterEmail` request fields. Attribute
      replies from the session principal. Wrong-owner, unmapped and missing tickets all return the same 404. Deploy the fail-closed backend before enabling the updated frontend.
      _(Backend done, commit `ecbec7b`: `listMyTickets(userId)`, `getPublicTicket(id, clientUserId)`
      and `publicReply(id, dto, clientUserId)` authorize strictly via `assertClientOwnsTicket`
      (`Ticket.userId === clientUserId` else 404); the reply's author is taken from the ticket, not
      the request body; no `?email=`/`requesterEmail` inputs remain. Wrong-owner, unmapped (`userId
null`) and missing tickets all return the identical 404. Unit-tested incl. the cross-client
      IDOR guard. The frontend now uses these session-bound routes.)_
- [x] **S2-8 Add an owner-scoped client attachment download.** The current client UI links to the
      staff-only `/api/attachments/:id/download` route. Add a separate client-session-protected
      route requiring `attachment.postId != null`, `post.ticket.userId === client.userId`,
      `post.isThirdParty === false` and no internal-note relation. Wrong owner/id returns the same 404.
      Point the client mapper at it and keep the staff route unchanged.
      _(Done on the API: `GET /api/attachments/client/:id/download` (`@ClientAuthenticated`) →
      `AttachmentsService.getClientDownloadableOrThrow` enforces post-attachment + non-third-party +
      not-a-note + `post.ticket.userId === client.userId`, same 404 on any failure. Staff route
      unchanged. Verified live (owner OK, other client 404, third-party 404) + boot smoke (401 without
      session); the client UI mapper points at this owner-scoped route.)_
- [x] **S2-9 Update the client UI.** Replace the free-form “enter any email to see tickets” flow with
      request-link, check-email, verify, session-expired and logout states. Never persist the verified
      email/session token in `localStorage`.
      _(Done in code: the old "enter any email" lookup and the `client_email` localStorage write
      (`submit-form`, `client-tickets-content`) are removed. New `use-client-auth.ts` hook
      (`useClientSession`/`useRequestClientLink`/`useVerifyClientToken`/`useClientLogout`) talks to
      `/client-auth/*` via a raw-fetch `clientFetch` (credentials-included, deliberately separate from
      the staff `api` client so a client 401 never triggers a staff refresh). `client-tickets-content`
      is now session-aware: signed out → a request-link form that always shows the same "check your
      email" confirmation (no enumeration); signed in → the user's own tickets + a sign-out button. New
      `/verify` page reads the `#token=` fragment, strips it with `history.replaceState`, POSTs it to
      `/client-auth/verify`, and shows verifying/success/invalid-or-expired states; the page sets
      `referrer: no-referrer` (matching `/reset-password`). `use-client-tickets` drops all `?email=`
      params + the staff-route fallback and points attachments at the owner-scoped
      `/attachments/client/:id/download` (S2-8). Backend link path fixed `/client/verify` → `/verify`
      to match the `(client)` route group. The code-level web/API gates are green. **VM evidence
      pending:** browser **e2e** of the full magic-link round-trip through the real mail path. S2-1
      keeps the portal fail-closed until that production gate passes.)_
- [~] **S2-10 Add ownership and replay tests.** Cover: unknown email response parity; expired token;
  consumed-token replay; concurrent double-consume (exactly one success); Client A cannot list,
  read, reply to or download attachments from Client B; aliases in `UserEmail`; session
  expiry/revocation; ambiguous/unlinked ownership fails closed; internal notes and third-party
  posts/attachments remain hidden.
  _(Unit matrix done, commits `ecbec7b`/`26096fb`/`cd434b5`: unknown-email response parity;
  expired/used/replayed token rejected; single-use consume proven (conditional CAS, exactly one
  winner); Client A → Client B list/detail/reply all 404 (IDOR guard) and owner-scoped attachment
  download 404; ambiguous `UserEmail` and unmapped `userId null` fail closed; session
  expiry/revocation → 401; internal notes and third-party posts/attachments hidden from the client
  view. **Deployment evidence pending:** the full HTTP/browser matrix and a real-mail magic-link
  round trip on the allowlisted stack; production remains closed until S6 records it.)_
- [x] **S2-11 Clean expired auth material.** Add an idempotent scheduled cleanup/TTL for used or expired
      login tokens and expired/revoked client sessions, with aggregate metrics and no secret output.
      _(Done, commit `ecbec7b`: `ClientAuthService.cleanupExpired()` idempotently `deleteMany`s
      used/expired login tokens and revoked/expired sessions, returning aggregate counts only (never a
      token or email). Scheduled hourly via `OnModuleInit` `setInterval` (`unref`-ed; disabled under
      `NODE_ENV=test`).)_

**S2 acceptance**

- anonymous/email-only requests to list/detail/reply fail;
- a verified client is bound to one stable `userId`, can access only that user’s tickets and can reply
  without submitting an identity;
- a verified client can download only attachments from their own public ticket posts;
- token replay, cross-client ID enumeration and email enumeration fail in integration/e2e tests;
- no magic-link/session secret appears in DB plaintext, URL/access logs, application logs or storage.

---

## 🔴 S3 — Staff-session correctness, CSRF and login abuse

- [x] **S3-1 Add immediate auth invalidation.** Add `authVersion` to `Staff` and include it in staff
      access tokens. On every protected request, verify the current enabled Staff record,
      `authVersion` and current StaffGroup permissions from the server-side source of truth. Start
      with the indexed DB lookup for correctness; benchmark before introducing any bounded cache.
      _(Done: migration `20260716010000_staff_auth_version`; access token carries `av`; `JwtAuthGuard`
      now loads the current Staff+group by indexed PK per request, checks `isEnabled` + `authVersion`,
      derives fresh permissions from the DB group, and fails closed 503 on DB outage. Bounded cache
      deferred pending a benchmark, as the plan allows.)_
- [x] **S3-2 Revoke on security changes.** In one transaction, increment `authVersion` and revoke all
      active refresh tokens when a password changes, staff is disabled, email/group changes, or a
      group’s admin/permission set changes. Group changes must invalidate every affected staff member.
      Password reset and operator password update must use the same invalidation service.
      _(Done: `AuthService.revokeStaffSessions` (used by logout + password reset); `StaffService.update`
      bumps authVersion + revokes refresh on password/group/email/isEnabled change; `disable` and
      `updateGroup` (permission change → all members) do the same. Verified against live Postgres,
      incl. the group-member relation-filter query. `isAdmin` isn't updatable via the group DTO.)_
- [x] **S3-3 Replace refresh-token scanning with direct session lookup.** Put opaque `jti` and
      `familyId` identifiers in each refresh JWT/row, look up exactly one row, verify its hash, and
      rotate it with a conditional transaction/CAS. Never scan a capped `take: 20` Argon2 candidate
      set. Exactly one concurrent request wins; the loser cannot mint a token or revoke the winner’s
      newly created session. Detect genuine later replay and revoke that family.
      _(Done: migration `20260716020000_refresh_token_rotation` adds `jti`/`familyId`; `refresh` does a
      direct `findUnique({ where: { jti } })`, verifies the hash, and rotates via a conditional
      `updateMany` CAS. A concurrent loser (CAS count 0 within a 10s grace) fails without touching the
      family; a replay outside the grace revokes the whole family. Verified end-to-end on live
      Postgres — parallel double-refresh yields exactly one winner, and a backdated replay revokes the
      family. **Race fix (self-review M1, migration `20260716030000_refresh_auth_version`):** each
      refresh row is stamped with its issue-time `authVersion`; a refresh whose stamp no longer matches
      the staff record is rejected before the CAS (quietly, no replay alarm) — so a concurrently
      rotating session can't outrun logout-all / password / permission changes. Verified live.)_
- [x] **S3-4 Use one authoritative logout model.** Make logout a documented logout-all operation:
      increment `authVersion` and revoke every refresh family in one transaction. Protected requests
      validate `authVersion` from DB, so correctness does not depend on a Redis jti blocklist; Redis may
      remain only as telemetry/defense in depth. A future current-device logout requires a separate
      access-token `sid`/session-family design, not mixed revocation mechanisms.
      _(Done: `logout` now delegates to `revokeStaffSessions` (authVersion bump + revoke-all in one tx);
      the jti blocklist is kept only as best-effort defense-in-depth.)_
- [x] **S3-5 Add real CSRF protection.** For cookie-authenticated unsafe methods, require both exact
      `Origin`/target-origin validation (strict allowlist, no wildcard subdomains) and a session-bound
      signed double-submit/synchronizer token in `X-CSRF-Token`.
      Exempt only explicitly enumerated non-browser webhooks, which retain their own authentication.
      Apply the custom header to JSON and multipart frontend calls.
      _(Done in code: global `CsrfGuard` requires both exact configured Origin/Referer and a matching
      HKDF/HMAC-signed readable cookie + `X-CSRF-Token` on cookie-authenticated unsafe requests.
      Login/refresh/client-verify require exact origin even before a credential cookie exists (login-CSRF
      protection); explicit Bearer clients and cookieless shared-secret webhooks remain exempt. Staff,
      client JSON and multipart frontend calls acquire/send the token. Unit matrix covers wrong origin,
      missing/mismatched/unsigned token, refresh-only cookie, subdomain rejection and webhook/Bearer paths.)_
- [x] **S3-6 Harden cookies.** Use production `__Host-`/`__Secure-` names compatible with the paths
      defined in S1, always `Secure`, `HttpOnly` for session cookies, no `Domain`, and identical
      attributes when clearing. Keep a separate readable CSRF cookie only if the signed pattern needs
      it. Same-origin `/api` is a prerequisite.
      _(Done: production staff access/refresh, client session and readable CSRF cookies use host-only
      `__Host-` names at `/`; session cookies are `Secure`/`HttpOnly`; current and legacy names/paths are
      cleared exactly. Refresh-only hard navigations recover through `/auth/me` without relying on a
      short-lived JS marker.)_
- [x] **S3-7 Remove externally-triggered hard account DoS.** Replace the distinguishable hard lock
      response with a generic login failure. Do not let anonymous failures permanently lock a known
      account: use progressive Redis-backed delay/throttles keyed by trusted IP + HMAC(email) and
      security alerts. S4 may add a challenge after the threshold. Preserve credential-stuffing
      protection without enumeration.
      _(Done: stale mainline `failedLoginAttempts`/`lockedUntil` columns remain for migration
      compatibility but are no longer read or written by authentication; the distinguishable hard
      lock response and global account DoS are removed. `LoginThrottleService` (`auth/login-throttle.service.ts`):
      a Redis counter keyed `th:login:<HMAC-SHA256(email)>:<ip>` that returns a generic **429** after
      10 failures in a 15-min sliding window and clears on success. Because the key is scoped to a
      single IP the counter can NEVER lock a known account out from its own IPs, and the raw email is
      HMAC-ed so addresses are never stored. **Fail-open:** a Redis outage never blocks a login (the
      per-IP `@Throttle(5/60s)` on `POST /auth/login` is the backstop); a `warn` alert fires when the
      throttle first engages. Verified live against real Redis: fresh key allowed → blocked/429 after
      10 failures → allowed after clear → a second IP for the same email stays allowed (no account
      lock). **Self-review hardening:** the counter's INCR+EXPIRE is a single atomic Lua eval (a
      counter can never be left without a TTL → no accidental permanent lock, verified live:
      count=10/ttl=900s); the HMAC key is HKDF-derived from the JWT secret (purpose-bound subkey, not
      the raw signing key); and `validateStaff` now runs a decoy argon2 verify on the missing/disabled
      branch so login timing no longer leaks account existence (the enumeration oracle that would have
      undermined "discloses nothing about account/lock state"). Action-bound Turnstile validation is
      implemented in S4; its production hostname/edge proof remains part of S6.)_
- [~] **S3-8 Test the state transitions.** Prove old access/refresh tokens fail immediately after
  password change, disable and permission/group change; CSRF requests from missing/wrong origins
  fail; valid same-origin JSON and multipart requests work; two parallel refreshes produce one
  winner without revoking it; genuine replay revokes its family; logout-all invalidates every
  access/refresh token. A DB/auth-state outage must fail closed with a controlled 503.
  _(Unit matrix done — each transition maps to a test: disabled staff → 401
  (`jwt-auth.guard.spec` "now-disabled"); password/permission/group change bumps `authVersion` so
  an old access token → 401 ("authVersion no longer matches"), and the `authVersion` bump itself is
  proven in `auth.service.spec`/`staff.service` (`revokeStaffSessions`); an old refresh with a stale
  `authVersion` stamp is rejected ("stale authVersion … WITHOUT a replay alarm"); CSRF wrong/missing
  origin → 403 and same-origin → pass (`csrf.guard.spec`, content-type-agnostic so it covers
  JSON+multipart); two parallel refreshes → one winner without revoking ("concurrent loser … fails
  WITHOUT revoking the family"); genuine replay revokes the family ("revoked long ago … revokes the
  whole family"); logout-all revokes every refresh (`auth.service.spec` "logout"); DB/auth outage →
  **503** (`jwt-auth.guard.spec` "fails CLOSED with 503", tagged S3-8). **Deployment evidence
  pending:** the full-HTTP multipart and live logout→old-access-token round trips are mandatory in
  the S6 allowlisted smoke.)_

**S3 acceptance**

- disabled/de-privileged staff and changed-password sessions lose access immediately;
- logout-all stays effective without Redis because DB `authVersion` is authoritative;
- cookie-authenticated mutations require a valid origin and CSRF token;
- login errors do not disclose account/lock state and cannot cheaply lock a known staff account.

---

## 🔴 S4 — Public abuse, upload safety and storage lifecycle

Implementation is complete; production scanner/load/storage evidence remains in S4-6/8/9 and S6.

- [x] **S4-1 Add a central challenge validator.** Integrate Turnstile (or an approved equivalent) via
      a server-side service with strict hostname, expected action, single-use and short-timeout checks,
      plus fail-closed production behavior. Ticket creation, request-link and upload each require their
      own action-bound challenge; one solved token cannot authorize two actions or requests.
      Client-authenticated replies use session/rate limits, not an identity CAPTCHA.
- [x] **S4-2 Add layered quotas.** Retain Redis endpoint throttles and add per-action limits keyed by
      trusted IP plus client/session/email-hash where available. Add a global emergency cap and alerts
      for ticket creation, reset/link emails, bytes uploaded and orphan count.
- [x] **S4-3 Remove large files from Node memory.** Replace `memoryStorage()` for public uploads with
      bounded temporary/quarantine storage or streaming. Enforce maximum total request bytes, file
      count and per-file size at both Caddy and API. Clean temp files on every success/error path.
- [x] **S4-4 Enforce limits at the attachment service boundary.** The same count, per-file, total-byte,
      MIME and quarantine rules must run inside `AttachmentsService`, not only the HTTP controller, so
      inbound-mail and future callers cannot bypass them. Until scanning is ready, reject public
      uploads and quarantine/retry inbound attachments with an observable failure; never silently drop
      them or make them downloadable.
- [x] **S4-5 Add malware scanning.** Scan the quarantined bytes with ClamAV/an approved scanner before
      moving to permanent storage or creating an adoptable attachment. Production fails closed when
      the scanner is unavailable. Keep MIME allowlist, magic-byte checks and extension denylist as
      defense in depth. Define policies for encrypted archives, nested/archive bombs, scanner signature
      freshness, CPU/memory/concurrency and ensure the scanner has no public port.
- [~] **S4-6 Reconcile and scan existing storage.** Before launch, compare DB attachment rows to files
  in both directions, quarantine mismatches, and scan every existing downloadable file. Handle
  write-then-DB-failure, partial multi-file upload and concurrent adoption without orphaning or
  exposing bytes.
- [x] **S4-7 Add orphan cleanup.** Implement an idempotent maintenance job using existing BullMQ (or
      an approved host scheduler) that deletes DB rows and files for unclaimed attachments older than
      the agreed TTL (initial recommendation: 24 hours). Retry partial FS/DB failures safely and emit
      counts/bytes, never filenames containing customer data.
- [~] **S4-8 Add storage monitoring.** Alert on disk usage, upload rejection rate, scanner failures,
  orphan bytes and cleanup failures. Document the emergency action that disables public upload
  without disabling staff ticket access.
- [~] **S4-9 Test abuse and cleanup.** Cover spoofed MIME, executable text, EICAR, encrypted/nested
  archive and archive-bomb policy, scanner outage/stale signatures, oversized/multi-file HTTP and
  inbound-mail requests, cross-action challenge replay, distributed-key behavior, orphan expiry,
  adoption races and file/row partial-failure recovery.

**S4 acceptance**

- an unauthenticated bot cannot submit/upload without a server-validated challenge;
- the agreed load test records configured upload concurrency, peak API/scanner RSS below their limits
  and zero OOMKills (the API currently has a 512 MB limit);
- malware/scanner outage never produces an adoptable production attachment;
- inbound mail cannot bypass upload limits/scanning, existing storage is reconciled/scanned, abandoned
  files are removed automatically and disk thresholds alert before exhaustion.

---

## 🔴 S5 — Production edge, secret isolation and preflight

- [ ] **S5-1 Select one canonical public edge.** Recommended: a named Cloudflare Tunnel with
      outbound-only origin connectivity. Remove host 80/443 publishing from the public compose stack,
      stop/disable `helpdesk-edge-nat`, remove its live NAT rules and bind the origin only to the
      private/loopback tunnel path. Remove Quick Tunnel production instructions and verify the old URL
      is dead. SSH remains Tailscale-only.
- [ ] **S5-2 Minimize edge secrets.** Remove `.env.prod` from the Caddy/cloudflared container. Pass
      only the exact edge variables it needs (`DOMAIN`, allowlist/tunnel settings). DB, Redis, JWT,
      SMTP, webhook and bootstrap secrets must not exist in the edge container environment.
- [ ] **S5-3 Restore the real client IP safely.** Trust `CF-Connecting-IP`/forwarded headers only from
      the private tunnel/Caddy hop; discard caller-supplied forwarding headers from untrusted paths.
      Configure Caddy trusted proxies and use its sanitized `client_ip` rather than tunnel
      `remote_ip`; keep API `trust proxy` aligned with the measured hop chain. Verify two external
      clients receive separate application rate-limit buckets and spoofed headers do not change
      identity.
      _(Security-review dependency: the S3-7 login throttle and the `@Throttle` limiter both key on
      `req.ip`. Their per-IP scoping — and the "can't poison a victim's counter" property — is only as
      trustworthy as this edge config. The service code correctly consumes the framework `req.ip` (no
      raw `X-Forwarded-For` parsing), so no code change is needed; the guarantee is completed HERE by
      making the API unreachable except through the one hop that overwrites inbound `X-Forwarded-For`.)_
- [ ] **S5-4 Create a canonical firewall ruleset.** Reconcile `helpdesk.nft` with
      `helpdesk-edge-nat.sh`; document exactly which interface/ports are allowed. With Tunnel, no
      inbound public 80/443 is needed. Keep DB/Redis/API/web container ports internal. Before applying,
      save the exact live nftables and iptables state; schedule a timed restore of those saved rules,
      never `nft flush ruleset`. Keep a second Tailscale session open, cancel rollback only after
      verification, then run an external port scan.
- [ ] **S5-5 Add privacy-safe edge logging and alerts.** Log request ID, trusted client IP, host,
      route/path, method, status, bytes and duration. Drop cookies, authorization, bodies and query
      strings. Alert on auth failures, 403/429 spikes, webhook failures and unusual upload volume.
- [ ] **S5-6 Reduce public service surface.** Externally expose only required endpoints. Return a
      generic liveness response or block `/api/health` at the edge. Keep Swagger disabled. Block
      Alaris if unused; put inbound mail behind source restrictions where possible, endpoint-specific
      rate/body limits and its strong secret. Do not expose internal DB/Redis health details.
- [x] **S5-7 Fix environment/file preflight coverage.** Update `scripts/preflight.sh` and production
      boot guards to require every secret including inbound webhook auth; reject placeholder/default
      bootstrap values, URLs, SMTP and domain settings; fail when any secret file is not owner-only
      `0600`; and never output values. Resolve `NEXT_PUBLIC_API_URL` by explicitly supporting an
      empty/unset value for same-origin relative `/api`.
      _(Done: `scripts/preflight.sh` (a) treats `NEXT_PUBLIC_API_URL` empty/unset as valid same-origin
      `/api` and requires `https://` only when set, and (b) fails when the env file is not owner-only
      `0600`/`0400`, never printing values. The TS boot guard `assertProductionSecrets` rejects
      placeholder/default JWT and Alaris secrets, plus a missing/malformed field-encryption key, AND now (S5-7) rejects a non-`https://`
      or localhost `TELECOM_HD_PUBLIC_URL` and a localhost/MailHog `TELECOM_HD_SMTP_HOST` in production —
      so a prod deploy cannot silently boot with the dev localhost origin (which would break the CSRF
      allowlist + magic-link/reset URLs) or a dev mail host (which would black-hole reset/login mail).
      Preflight and the boot guard also require a strong `TELECOM_HD_INBOUND_WEBHOOK_SECRET`, along
      with the Alaris/JWT/encryption secrets. Bootstrap credentials are forbidden in `.env.prod` and
      are accepted only by the removed one-shot helper. VM execution remains part of S6.)_
- [~] **S5-8 Add a separate DB-aware go-live audit.** Run only on the VM with read-only DB credentials.
  Fail when any enabled staff hash matches a shipped/default password, when demo identities remain
  enabled, or when bootstrap/reset/session invariants are unsafe. Keep this separate from the
  environment-only preflight and print aggregate findings only.
  _(Implemented as the aggregate-only production-readiness/ownership/template/storage audits;
  execution against the live production database is still required.)_
- [~] **S5-9 Make public builds deterministic.** Ensure the public deploy command rebuilds web/API
  when build-time URL/config changes, renders the intended compose stack and proves the browser
  bundle calls same-origin `/api`. Tag API/web images immutably with a release ID and record a
  non-secret config checksum; do not reuse an unknown stale tailnet image.
  _(Implemented: `deploy-prod.sh` requires the exact clean fetched `origin/main`, derives a
  non-secret `NEXT_PUBLIC_\*`digest via`scripts/web-build-id.sh`, and gives each release/config
  variant an immutable web tag. The VM compose render and browser-bundle proof remain pending.)\_
- [~] **S5-10 Patch runtimes deliberately.** After approval, update Caddy, Node base images and the
  PostgreSQL minor release to current supported security patches, one risk domain at a time.
  Review release notes, back up first, run targeted tests, verify migrations/restore, and retain a
  rollback image/tag. Do not combine these upgrades with functional auth changes in one commit.
  _(Production runtime and application dependency pins are explicit in the release candidate;
  image pull/scan and live restore evidence remain a VM gate.)_

**S5 acceptance**

- the origin has no bypass around the chosen edge and no unexpected public listeners;
- edge containers cannot read application/database/mail/JWT secrets;
- client IP and rate limits are correct through the real production proxy chain;
- health/unused webhooks/internal ports are unreachable from the public Internet;
- secret files are `0600`; environment preflight and the separate DB audit are green on the **VM**;
  compose render is reviewed and the rebuilt browser uses same-origin `/api`;
- runtime patch upgrades pass their targeted and full gates.

---

## 🔴 S6 — Verification, staged release and rollback

- [~] **S6-1 Run targeted gates per batch.** Start with file/module-scoped unit and integration tests,
  then API/web typecheck, lint and build. Ask before the heavy Docker reset/rebuild and
  `make verify-full` gate.
  _(Targeted security suites and API/web typecheck/lint are green; the exact final-commit full
  gate and production container evidence must still be recorded.)_
- [~] **S6-2 Replace the incompatible production smoke path.** Add mandatory `scripts/smoke-prod.sh`
  using a cookie jar, CSRF flow and an approved temporary real test account; it must not use demo
  credentials, parse JWT JSON, assume Swagger or print webhook secrets. Update dev `smoke.sh`,
  diagnostics and e2e separately. Update `scripts/verify.sh` so production verification fails—not
  silently skips—when the target stack/smoke prerequisites are absent.
  _(`scripts/smoke-prod.sh` implements the cookie-only/CSRF/refresh/logout contract without
  printing secrets. It still must pass through the approved production HTTPS edge.)_
- [~] **S6-3 Apply migrations to a fresh database.** Prove every migration applies from zero and
  upgrades a restored production-shaped copy. Prefer expand/contract migrations compatible with
  the previous image; document the forward-fix boundary and never test destructive rollback live.
  _(Historical evidence only: an earlier 31-migration chain applied locally on disposable PostgreSQL 15,
  seed succeeded and the ownership audit reported CLEAN. It is superseded by the current 51-migration
  release. **Still open and mandatory before deploy:** current-image from-zero proof plus upgrade and
  audit of a restored production-shaped copy behind the allowlist.)_
- [ ] **S6-4 Run the security repro matrix behind the allowlist.** At minimum, prove anonymous/email-only
      client list/detail/reply/download fail; Client A cannot access/mutate Client B; secrets never
      appear in JSON/logs; old sessions fail after password/role/disable/logout; wrong-origin or
      missing-CSRF mutations fail; reset/refresh races have one winner; demo credentials fail; challenge,
      rate, HTTP/inbound upload, AV and cleanup fail closed; external IPs remain distinct; and origin
      ports, health details and unused webhooks remain unreachable.
- [ ] **S6-5 Run dependency/image and external web checks.** Use approved tooling to scan production
      dependencies/images and run a non-destructive DAST/baseline scan against the allowlisted staging
      route. Triage every HIGH/CRITICAL finding before proceeding.
- [~] **S6-6 Rehearse rollback and kill switch.** Deploy immutable image tags plus config checksum and
  auto-abort on failed smoke. Prove the named tunnel can be stopped/disabled within the agreed
  minute-level objective while Tailscale remains alive. Before the migration boundary, rollback
  must prove old services healthy and BullMQ resumed; after it, fail closed and finish forward or
  restore the exact DB/uploads/Redis triplet plus matching immutable images. Never restore rotated
  secrets. Record migration boundary, forward-fix and restore owner.
  _(The deploy helper implements the boundary traps, immutable tags, queue pause/drain, exact
  backup triplet provenance and owner-only recovery manifest. An attended VM rehearsal and edge
  kill-switch timing are still required.)_
- [ ] **S6-7 Stage exposure.** Deploy first behind the existing owner CIDRs, then a small support pilot.
      Observe auth failures, 4xx/5xx, latency, queues, disk, database and scanner metrics for an agreed
      soak period. Expand public policy only after the review sign-off.
- [~] **S6-8 Update truth docs.** Mark this goal honestly, update `docs/GO_LIVE_STATUS.md`, deploy/access
  runbooks and API/database/architecture docs. Remove stale claims that email-only ownership,
  Quick Tunnel or deferred AV are production-safe.
  _(Release-candidate docs describe the implemented controls and keep public GO blocked; this
  item closes only after exact VM/edge evidence is linked.)_

---

## ✅ Definition of Done — public GO gate

Public launch is allowed only when every item below is checked:

- [ ] S0–S6 are complete with focused commits and linked verification evidence.
- [ ] Production has no enabled demo staff, known/default credential or pre-cutover session.
- [ ] No auth/reset/client token or customer email query appears in API/proxy logs or JSON responses.
- [ ] Client list/detail/reply/download requires a verified, revocable session bound to stable `userId`.
- [ ] Staff password/disable/permission changes and logout invalidate access immediately.
- [ ] Cookie-authenticated mutations enforce exact origin + CSRF token.
- [ ] Public create/link/upload has challenge, layered limits, bounded memory/storage and cleanup.
- [ ] HTTP/inbound and existing attachments obey the same limits and are scanned before adoption/use;
      scanner failure is fail-closed and storage reconciliation is green.
- [ ] One canonical edge hides the origin, preserves trusted client IP and exposes no internal ports.
- [ ] Edge containers receive no application secrets; health/unused webhooks are not public.
- [ ] VM env preflight + DB audit, fresh migration, backup→restore, targeted tests, mandatory
      `smoke-prod.sh`, `make verify` and approved full e2e are green.
- [ ] External HIGH/CRITICAL scan findings are closed or explicitly risk-accepted by the owner.
- [ ] Kill switch and Tailscale rollback access are proven.
- [ ] Google/OIDC remains untouched and is tracked as the next separate goal.

## References

- Local evidence: `apps/api/src/auth/`, `apps/api/src/modules/tickets/`,
  `apps/api/src/modules/attachments/`, `infra/caddy/`, `docker-compose.prod.yml`,
  `docker-compose.proxy.yml`, `scripts/preflight.sh`, `scripts/deploy-prod.sh`, `docs/DEPLOY.md` and
  `docs/GO_LIVE_STATUS.md`.
- OWASP: Authentication, CSRF Prevention and File Upload Cheat Sheets.
- Cloudflare: production Named Tunnel, visitor-IP restoration, Turnstile server-side validation and
  WAF rate-limiting documentation.
