# GOAL — Security fixes before public access

_Created: 2026-07-16. Status: **IN PROGRESS — PUBLIC GO-LIVE BLOCKED**. S1 secret-leakage core (code) landed; S0 ops, S1 cookie-only/rotation and S2–S6 remain._

Run later as an implementation goal: `/goal docs/GOAL_PUBLIC_SECURITY.md`.

This plan closes the security bugs found during the 2026-07-16 read-only review. The portal must
remain behind the current CIDR/Tailscale restriction until the full Definition of Done is green.

> **Progress (2026-07-16 — commit on `claude/helpdesk-security-workflow-rycs0y`).** Landed the
> local, non-breaking S1 secret-leakage core with tests (573 API unit tests green, api + web
> typecheck/lint clean):
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
> **Still open (need production access, approvals, new deps, or a breaking-contract change — not
> done here):** S1-6/1-7/1-8 (cookie-only auth: remove JWT from login/refresh JSON, exact cookie
> scoping, XSS-can't-read proof — breaks the current frontend token contract), S1-9 (secret
> rotation / credential cutover), and all of S0, S2, S3, S4, S5, S6.

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
      _(Partially done: logging redaction, reset-mail DI, reset-race and reset-mail fail-safe landed
      in code + tests. Cookie-only (S1-6/7/8) and the secret rotation (S1-9) remain.)_
- [ ] **H2 Close the client IDOR:** API fail-closes list/detail/reply and client attachment access;
      temporarily hide/disable those UI actions until the verified client-session flow is complete.
      Untrusted public attachment upload stays disabled until S4 is green.
- [ ] **H3 Close staff-auth gaps:** use DB-backed `authVersion`, logout-all revocation, atomic refresh
      rotation and origin + CSRF checks for every cookie-authenticated mutation.
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
      _(Done: conditional `updateMany` consume + unit coverage; fragment delivery + `replaceState` +
      `referrer: no-referrer` in the reset page. A true multi-process concurrency test belongs in the
      Testcontainers integration suite and is still to be added.)_
- [ ] **S1-6 Make browser auth cookie-only.** `POST /api/auth/login` returns only the safe staff
      principal; refresh returns a non-secret success shape. Remove refresh-token body DTO fallback
      after inventorying real non-browser consumers. Update web types/hooks, API tests, diagnostics,
      e2e, `scripts/smoke.sh`, docs and any screenshots/audit scripts that parse token JSON. If machine
      tokens are required, design a separate scoped flow.
- [ ] **S1-7 Define and clear cookies exactly.** Use host-only secure cookies with no `Domain`; scope
      the refresh cookie to `/api/auth/refresh` where compatible and keep the access cookie available
      to `/api`. Use the exact same name/path/security attributes when clearing, clear legacy names and
      paths during cutover, and clear both cookies on every invalid refresh response.
- [ ] **S1-8 Prove XSS cannot read a refreshed token.** From browser-context integration/e2e tests,
      call refresh and assert the response body contains no access/refresh token while cookies rotate.
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

- [ ] **S2-1 Add a fail-closed interim gate.** While S2 is incomplete, production must return 404/503
      for `GET /api/tickets/my`, `GET /api/tickets/public/:id`, client attachment download and
      `POST /api/tickets/public/:id/reply`. Remove/hide matching reply, upload and download UI actions.
      Keep public ticket creation only after S4. The API gate defaults closed in production and does
      not depend on frontend behavior.
- [ ] **S2-2 Establish one stable ownership identity before migrating.** Audit and normalize
      `UserEmail`, reject/fix case-insensitive duplicates, and enforce a DB-level normalized-email
      uniqueness invariant. Backfill `Ticket.userId` only when one normalized email maps to exactly one
      user; ambiguous or unlinked tickets remain inaccessible and enter a manual-resolution report.
- [ ] **S2-3 Add client-auth persistence.** Add Prisma models/migration for a single-use hashed login
      token and a hashed client session. Both require a non-null stable `userId`; normalized email is an
      audit snapshot, never the authorization key. Include expiry, `usedAt`/`revokedAt`, created and
      last-seen fields. Store only SHA-256/HMAC hashes of cryptographically random tokens, index active
      lookup/expiry and never persist the raw token.
- [ ] **S2-4 Implement request-link.** Add a public, tightly throttled endpoint that accepts an email,
      normalizes it, always returns the same 202 response, invalidates older unused tokens and queues
      a short-lived link only when the address maps unambiguously to one `userId` that owns at least one
      ticket. Bind the token to that `userId`. Key limits by trusted client IP and HMAC(normalized
      email); do not expose account existence.
- [ ] **S2-5 Keep the magic token out of proxy logs.** Preferred browser flow:
      `/client/verify#token=<raw>` → client JS immediately removes the fragment with
      `history.replaceState` → POSTs the token in a non-logged body to a verify endpoint. The API
      atomically consumes the single-use token, creates a client session and sets an `HttpOnly`,
      `Secure`, host-only cookie. Set `Referrer-Policy: no-referrer` on the verification page.
- [ ] **S2-6 Add an explicit client auth mode.** Implement `@ClientAuthenticated()` metadata/decorator
      and guard composition so the global staff JWT guard cannot block client routes and `@Public()`
      cannot accidentally expose them. Resolve the session to a client principal containing `userId`,
      reject expired/revoked sessions, and add logout/revocation. Do not reuse staff JWT/RBAC identity.
- [ ] **S2-7 Remove caller-controlled ownership.** Client list/detail/reply services authorize only by
      `Ticket.userId === client.userId`; remove `?email=` and `requesterEmail` request fields. Attribute
      replies from the session principal. Wrong-owner, unmapped and missing tickets all return the same 404. Deploy the fail-closed backend before enabling the updated frontend.
- [ ] **S2-8 Add an owner-scoped client attachment download.** The current client UI links to the
      staff-only `/api/attachments/:id/download` route. Add a separate client-session-protected
      route requiring `attachment.postId != null`, `post.ticket.userId === client.userId`,
      `post.isThirdParty === false` and no internal-note relation. Wrong owner/id returns the same 404.
      Point the client mapper at it and keep the staff route unchanged.
- [ ] **S2-9 Update the client UI.** Replace the free-form “enter any email to see tickets” flow with
      request-link, check-email, verify, session-expired and logout states. Never persist the verified
      email/session token in `localStorage`.
- [ ] **S2-10 Add ownership and replay tests.** Cover: unknown email response parity; expired token;
      consumed-token replay; concurrent double-consume (exactly one success); Client A cannot list,
      read, reply to or download attachments from Client B; aliases in `UserEmail`; session
      expiry/revocation; ambiguous/unlinked ownership fails closed; internal notes and third-party
      posts/attachments remain hidden.
- [ ] **S2-11 Clean expired auth material.** Add an idempotent scheduled cleanup/TTL for used or expired
      login tokens and expired/revoked client sessions, with aggregate metrics and no secret output.

**S2 acceptance**

- anonymous/email-only requests to list/detail/reply fail;
- a verified client is bound to one stable `userId`, can access only that user’s tickets and can reply
  without submitting an identity;
- a verified client can download only attachments from their own public ticket posts;
- token replay, cross-client ID enumeration and email enumeration fail in integration/e2e tests;
- no magic-link/session secret appears in DB plaintext, URL/access logs, application logs or storage.

---

## 🔴 S3 — Staff-session correctness, CSRF and login abuse

- [ ] **S3-1 Add immediate auth invalidation.** Add `authVersion` to `Staff` and include it in staff
      access tokens. On every protected request, verify the current enabled Staff record,
      `authVersion` and current StaffGroup permissions from the server-side source of truth. Start
      with the indexed DB lookup for correctness; benchmark before introducing any bounded cache.
- [ ] **S3-2 Revoke on security changes.** In one transaction, increment `authVersion` and revoke all
      active refresh tokens when a password changes, staff is disabled, email/group changes, or a
      group’s admin/permission set changes. Group changes must invalidate every affected staff member.
      Password reset and operator password update must use the same invalidation service.
- [ ] **S3-3 Replace refresh-token scanning with direct session lookup.** Put opaque `jti` and
      `familyId` identifiers in each refresh JWT/row, look up exactly one row, verify its hash, and
      rotate it with a conditional transaction/CAS. Never scan a capped `take: 20` Argon2 candidate
      set. Exactly one concurrent request wins; the loser cannot mint a token or revoke the winner’s
      newly created session. Detect genuine later replay and revoke that family.
- [ ] **S3-4 Use one authoritative logout model.** Make logout a documented logout-all operation:
      increment `authVersion` and revoke every refresh family in one transaction. Protected requests
      validate `authVersion` from DB, so correctness does not depend on a Redis jti blocklist; Redis may
      remain only as telemetry/defense in depth. A future current-device logout requires a separate
      access-token `sid`/session-family design, not mixed revocation mechanisms.
- [ ] **S3-5 Add real CSRF protection.** For cookie-authenticated unsafe methods, require both exact
      `Origin`/target-origin validation (strict allowlist, no wildcard subdomains) and a session-bound
      signed double-submit/synchronizer token in `X-CSRF-Token`.
      Exempt only explicitly enumerated non-browser webhooks, which retain their own authentication.
      Apply the custom header to JSON and multipart frontend calls.
- [ ] **S3-6 Harden cookies.** Use production `__Host-`/`__Secure-` names compatible with the paths
      defined in S1, always `Secure`, `HttpOnly` for session cookies, no `Domain`, and identical
      attributes when clearing. Keep a separate readable CSRF cookie only if the signed pattern needs
      it. Same-origin `/api` is a prerequisite.
- [ ] **S3-7 Remove externally-triggered hard account DoS.** Replace the distinguishable hard lock
      response with a generic login failure. Do not let anonymous failures permanently lock a known
      account: use progressive Redis-backed delay/throttles keyed by trusted IP + HMAC(email) and
      security alerts. S4 may add a challenge after the threshold. Preserve credential-stuffing
      protection without enumeration.
- [ ] **S3-8 Test the state transitions.** Prove old access/refresh tokens fail immediately after
      password change, disable and permission/group change; CSRF requests from missing/wrong origins
      fail; valid same-origin JSON and multipart requests work; two parallel refreshes produce one
      winner without revoking it; genuine replay revokes its family; logout-all invalidates every
      access/refresh token. A DB/auth-state outage must fail closed with a controlled 503.

**S3 acceptance**

- disabled/de-privileged staff and changed-password sessions lose access immediately;
- logout-all stays effective without Redis because DB `authVersion` is authoritative;
- cookie-authenticated mutations require a valid origin and CSRF token;
- login errors do not disclose account/lock state and cannot cheaply lock a known staff account.

---

## 🔴 S4 — Public abuse, upload safety and storage lifecycle

External service/container/config additions in this batch require approval before implementation.

- [ ] **S4-1 Add a central challenge validator.** Integrate Turnstile (or an approved equivalent) via
      a server-side service with strict hostname, expected action, single-use and short-timeout checks,
      plus fail-closed production behavior. Ticket creation, request-link and upload each require their
      own action-bound challenge; one solved token cannot authorize two actions or requests.
      Client-authenticated replies use session/rate limits, not an identity CAPTCHA.
- [ ] **S4-2 Add layered quotas.** Retain Redis endpoint throttles and add per-action limits keyed by
      trusted IP plus client/session/email-hash where available. Add a global emergency cap and alerts
      for ticket creation, reset/link emails, bytes uploaded and orphan count.
- [ ] **S4-3 Remove large files from Node memory.** Replace `memoryStorage()` for public uploads with
      bounded temporary/quarantine storage or streaming. Enforce maximum total request bytes, file
      count and per-file size at both Caddy and API. Clean temp files on every success/error path.
- [ ] **S4-4 Enforce limits at the attachment service boundary.** The same count, per-file, total-byte,
      MIME and quarantine rules must run inside `AttachmentsService`, not only the HTTP controller, so
      inbound-mail and future callers cannot bypass them. Until scanning is ready, reject public
      uploads and quarantine/retry inbound attachments with an observable failure; never silently drop
      them or make them downloadable.
- [ ] **S4-5 Add malware scanning.** Scan the quarantined bytes with ClamAV/an approved scanner before
      moving to permanent storage or creating an adoptable attachment. Production fails closed when
      the scanner is unavailable. Keep MIME allowlist, magic-byte checks and extension denylist as
      defense in depth. Define policies for encrypted archives, nested/archive bombs, scanner signature
      freshness, CPU/memory/concurrency and ensure the scanner has no public port.
- [ ] **S4-6 Reconcile and scan existing storage.** Before launch, compare DB attachment rows to files
      in both directions, quarantine mismatches, and scan every existing downloadable file. Handle
      write-then-DB-failure, partial multi-file upload and concurrent adoption without orphaning or
      exposing bytes.
- [ ] **S4-7 Add orphan cleanup.** Implement an idempotent maintenance job using existing BullMQ (or
      an approved host scheduler) that deletes DB rows and files for unclaimed attachments older than
      the agreed TTL (initial recommendation: 24 hours). Retry partial FS/DB failures safely and emit
      counts/bytes, never filenames containing customer data.
- [ ] **S4-8 Add storage monitoring.** Alert on disk usage, upload rejection rate, scanner failures,
      orphan bytes and cleanup failures. Document the emergency action that disables public upload
      without disabling staff ticket access.
- [ ] **S4-9 Test abuse and cleanup.** Cover spoofed MIME, executable text, EICAR, encrypted/nested
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
- [ ] **S5-7 Fix environment/file preflight coverage.** Update `scripts/preflight.sh` and production
      boot guards to require every secret including inbound webhook auth; reject placeholder/default
      bootstrap values, URLs, SMTP and domain settings; fail when any secret file is not owner-only
      `0600`; and never output values. Resolve `NEXT_PUBLIC_API_URL` by explicitly supporting an
      empty/unset value for same-origin relative `/api`.
- [ ] **S5-8 Add a separate DB-aware go-live audit.** Run only on the VM with read-only DB credentials.
      Fail when any enabled staff hash matches a shipped/default password, when demo identities remain
      enabled, or when bootstrap/reset/session invariants are unsafe. Keep this separate from the
      environment-only preflight and print aggregate findings only.
- [ ] **S5-9 Make public builds deterministic.** Ensure the public deploy command rebuilds web/API
      when build-time URL/config changes, renders the intended compose stack and proves the browser
      bundle calls same-origin `/api`. Tag API/web images immutably with a release ID and record a
      non-secret config checksum; do not reuse an unknown stale tailnet image.
- [ ] **S5-10 Patch runtimes deliberately.** After approval, update Caddy, Node base images and the
      PostgreSQL minor release to current supported security patches, one risk domain at a time.
      Review release notes, back up first, run targeted tests, verify migrations/restore, and retain a
      rollback image/tag. Do not combine these upgrades with functional auth changes in one commit.

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

- [ ] **S6-1 Run targeted gates per batch.** Start with file/module-scoped unit and integration tests,
      then API/web typecheck, lint and build. Ask before the heavy Docker reset/rebuild and
      `make verify-full` gate.
- [ ] **S6-2 Replace the incompatible production smoke path.** Add mandatory `scripts/smoke-prod.sh`
      using a cookie jar, CSRF flow and an approved temporary real test account; it must not use demo
      credentials, parse JWT JSON, assume Swagger or print webhook secrets. Update dev `smoke.sh`,
      diagnostics and e2e separately. Update `scripts/verify.sh` so production verification fails—not
      silently skips—when the target stack/smoke prerequisites are absent.
- [ ] **S6-3 Apply migrations to a fresh database.** Prove every migration applies from zero and
      upgrades a restored production-shaped copy. Prefer expand/contract migrations compatible with
      the previous image; document the forward-fix boundary and never test destructive rollback live.
- [ ] **S6-4 Run the security repro matrix behind the allowlist.** At minimum, prove anonymous/email-only
      client list/detail/reply/download fail; Client A cannot access/mutate Client B; secrets never
      appear in JSON/logs; old sessions fail after password/role/disable/logout; wrong-origin or
      missing-CSRF mutations fail; reset/refresh races have one winner; demo credentials fail; challenge,
      rate, HTTP/inbound upload, AV and cleanup fail closed; external IPs remain distinct; and origin
      ports, health details and unused webhooks remain unreachable.
- [ ] **S6-5 Run dependency/image and external web checks.** Use approved tooling to scan production
      dependencies/images and run a non-destructive DAST/baseline scan against the allowlisted staging
      route. Triage every HIGH/CRITICAL finding before proceeding.
- [ ] **S6-6 Rehearse rollback and kill switch.** Deploy immutable image tags plus config checksum and
      auto-abort on failed smoke. Prove the named tunnel can be stopped/disabled within the agreed
      minute-level objective while Tailscale remains alive. Rollback restores code/images/config only;
      never restore rotated secrets. Record migration boundary, forward-fix and restore owner.
- [ ] **S6-7 Stage exposure.** Deploy first behind the existing owner CIDRs, then a small support pilot.
      Observe auth failures, 4xx/5xx, latency, queues, disk, database and scanner metrics for an agreed
      soak period. Expand public policy only after the review sign-off.
- [ ] **S6-8 Update truth docs.** Mark this goal honestly, update `docs/GO_LIVE_STATUS.md`, deploy/access
      runbooks and API/database/architecture docs. Remove stale claims that email-only ownership,
      Quick Tunnel or deferred AV are production-safe.

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
  `apps/api/src/modules/attachments/`, `infra/caddy/`, `docker-compose.public.yml`,
  `scripts/preflight.sh`, `deploy.md`, `docs/GO_LIVE_STATUS.md`.
- OWASP: Authentication, CSRF Prevention and File Upload Cheat Sheets.
- Cloudflare: production Named Tunnel, visitor-IP restoration, Turnstile server-side validation and
  WAF rate-limiting documentation.
