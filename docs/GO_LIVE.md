# GOAL — Go-Live: the production tail (autonomous)

Run: `/goal docs/GO_LIVE.md`.

The product is **`v1.0-pilot`** (tag): gate green (tsc · vitest · build · lint · e2e 37/37), security
hardened H1–H8, Kayako migration M0–M4 implemented. **The code is solid.** What stands between this
and _real production traffic_ is **integration + operations, not code quality**. This goal closes
exactly that tail — in order, by risk.

> A "green gate" is NOT "production ready". The gate proves the code compiles, tests pass, and the
> dev stack boots. It does **not** prove the inbound-email heart works against a real mailbox, that a
> prod deploy boots without the demo seed, or that there are backups. That is what G1–G3 below cover.

## Operating rules (EVERY batch) — same discipline as GOAL_HARDEN

1. Take ONE batch (smallest coherent slice). Write/extend a test for each change.
2. **Self-gate:** `make reset && make up && make verify` MUST stay green (the DEV profile, demo seed, http).
   Never commit red. The dev loop must keep working — harden only the **prod** profile.
3. Anything security/integration MUST be **live-verified** (curl / a real container / e2e), not just code.
4. One focused commit + push per batch. Tick it done here. Move on.
5. **User-supplied values are NOT blockers.** Where a step needs real secrets / domain / IMAP creds /
   TLS cert (marked 🙋 USER below), build and test the **mechanism** against a local container
   (GreenMail/Dovecot for IMAP, self-signed cert for TLS) and document precisely what the user must
   plug in. Do NOT fake it, do NOT hardcode, do NOT skip the test.
6. Don't gold-plate. Don't touch "OUT OF SCOPE".
7. STOP when all batches done AND the Definition of Done is green; run `make verify-full` once more,
   then post a final summary.

---

## 🔴 Batch G1 — Inbound email path, end-to-end against a REAL mailbox (HIGHEST RISK)

This is the **heart of 23 Telecom**: a customer emails `noc@23telecom.net` → the system auto-creates a
**CLIENT** ticket → NOC spawns a **LINKED SUPPLIER** ticket (`TicketLink`), with dual
"to customer" / "to vendor" macros. Today only the **outbound** side is exercised (MailHog is an SMTP
sink). The **inbound transport** — connecting to a real mailbox, parsing real MIME, threading,
dedup — has **never run against anything but samples**. Until it does, the core flow is unproven.

- [ ] **G1-1 Inbound transport.** Confirm/implement the ingestion path: IMAP poll (or SMTP pipe) of the
      `noc@` mailbox, configured via env (`TELECOM_HD_IMAP_*` / `TELECOM_HD_INBOUND_*`). It must run on a
      schedule (cron/queue), be idempotent, and survive restart without re-ingesting.
- [ ] **G1-2 Real-mailbox integration test.** Stand up a **real IMAP server in a container**
      (GreenMail or Dovecot) — NOT MailHog. Deliver a genuine multipart MIME email to it, run the
      ingester, and assert: a CLIENT ticket is created; the requester org is matched/created with the
      right `orgType`; the body is parsed (HTML+text, quote-strip on replies); a follow-up reply with the
      same `Message-ID`/`In-Reply-To` **threads** onto the same ticket and does **not** duplicate.
- [ ] **G1-3 Spawn-supplier from a real inbound email.** From an inbound client email, exercise
      `POST /tickets/:id/spawn-supplier` (auto or one-click) → a separate SUPPLIER ticket is created and
      `TicketLink` exists **both directions**; the vendor macro renders.
- [ ] **G1-4 Loop / bounce protection.** Confirm the autoresponder gate + a parser loop-block
      (Kayako had `swparserloopblocks`/`swparserlooprules`) prevent a mail loop (auto-reply → auto-reply).
      Add a test: two rapid auto-generated emails do not ping-pong.
- 🙋 **USER** provides, when going live for real: the real `noc@` IMAP host/user/app-password and the MX/DNS.
  The bot does **all** of the above against the **local IMAP container** and documents the env keys.
- **DoD:** a real email delivered to the test IMAP server shows up in the UI as a **linked client+supplier
  pair**; a retry/re-poll creates **no duplicate**; quote-strip + threading verified live; loop-block tested.

## 🟠 Batch G2 — Production deploy profile (actually runnable on a server)

Today: `NODE_ENV=development`, the demo seed **re-runs on every boot** (resets admin to `demo1234`),
`NEXT_PUBLIC_API_URL` is baked to `localhost`, secret validation is **length-only** (`change-me`
placeholders pass), the Alaris webhook secret has a **known default**, no TLS. None of that can ship.

- [ ] **G2-1 Prod profile.** A `docker-compose.prod.yml` (or profile) with `NODE_ENV=production`,
      **demo seed OFF** (verify the seed guard actually refuses to run in prod), `migrate deploy` only,
      `restart: unless-stopped`.
- [ ] **G2-2 Secret gate (fail-fast).** On prod boot, **reject** default / `change-me` / low-entropy
      values for the JWT access+refresh secrets and the Alaris webhook secret — not just length≥32.
      App must refuse to start with weak secrets in prod. Add a test for the gate.
- [ ] **G2-3 Real origin.** `NEXT_PUBLIC_API_URL` set at build to the real domain; web → api over the
      real origin (not localhost). Document the build arg.
- [ ] **G2-4 TLS / reverse proxy.** Provide a reference proxy config (Caddy or nginx) terminating TLS →
      `web:3000` + `api:4000`, with security headers. Confirm `helmet` is active on the api. Test with a
      **self-signed** cert locally (curl over https → 200).
- [ ] **G2-5 First-admin bootstrap.** A one-time, documented way to create the real first admin
      (NOT the demo user) — e.g. an idempotent `seed:admin` that reads `TELECOM_HD_BOOTSTRAP_ADMIN_*`
      and is a no-op if the user exists.
- 🙋 **USER** provides at go-live: domain, TLS cert (or Caddy auto-HTTPS email), real secret values,
  the bootstrap admin credentials. The bot builds + tests the **mechanism** with placeholders/self-signed.
- **DoD:** `docker compose -f docker-compose.prod.yml up` boots with the prod env, runs **no demo seed**,
  **refuses weak secrets**, serves over the proxy on https; smoke: bootstrap admin logs in (no `demo1234`).

## 🟡 Batch G3 — Operations: backups, monitoring, log hygiene

- [ ] **G3-1 DB backup + restore runbook.** A documented `pg_dump` schedule (cron or a compose sidecar)
      writing timestamped dumps, **plus a restore runbook that you actually test** (dump → drop → restore →
      data back). Put it in `docs/`.
- [ ] **G3-2 Health + monitoring.** Confirm/add api liveness/readiness (`/health` incl. DB+Redis check)
      and a web health check; ensure the H5 jti fail-open ERROR ("Redis unreachable, fail-open BYPASS")
      surfaces to logs/metrics so the revocation-bypass window is observable.
- [ ] **G3-3 Log hygiene.** Container log rotation (json-file `max-size`/`max-file`, or pino→stdout→collector)
      so disks don't fill; no secrets in logs.
- **DoD:** a proven backup→restore cycle; `/health` returns dependency status; logs are rotated and clean.

---

## 🟦 Decision (document the choice, not a code task)

- **Multi-tenancy.** The product is **single-tenant**. If 23 Telecom is the only user, this is correct —
  do nothing. If a second isolated org is ever needed, that's a Phase-2 redesign (row-level org scoping).
  Record the decision as a short ADR (`docs/adr/`).

## ⛔ OUT OF SCOPE (do NOT touch here)

- **Real bulk data import** — that's the separate dump task (`tsx scripts/import-kayako.ts <dump>`),
  blocked on the user exporting the mysqldump. G1's _email_ test uses synthetic mail, not the real dump.
- Load/scale testing, CI/CD (none by design — CLAUDE.md), advanced SLA working-hours editor,
  anything already green (don't re-polish H1–H8 / M0–M4).

## ✅ Definition of Done (whole goal)

- [ ] **G1:** real inbound email (via a local IMAP container) → a **linked client+supplier ticket pair** in
      the UI, threaded, **no duplicate** on re-poll, loop-block tested. Live, not MailHog.
- [ ] **G2:** a prod profile that boots with **no demo seed**, **rejects weak secrets**, serves over TLS via a
      documented proxy, and lets a **bootstrap admin** (not `demo1234`) log in.
- [ ] **G3:** backup→restore proven; `/health` reports dependencies; logs rotated.
- [ ] `make verify-full` still **GREEN** on the dev profile after all batches.
- [ ] A short `docs/GO_LIVE_STATUS.md` honestly stating what is live-verified vs what still needs
      USER-supplied real creds/domain to flip on.
