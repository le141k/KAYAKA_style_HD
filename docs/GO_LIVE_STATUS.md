# GO-LIVE STATUS — 23 Telecom Help Desk

_Last updated: 2026-05-25. Honest snapshot of what is **live-verified** vs what still
needs **USER-supplied** real credentials / infrastructure before production._

This complements `docs/GO_LIVE.md` (the checklist) and `docs/GOAL_AUDIT_FIX.md` (the audit
fixes). It exists so nobody has to reverse-engineer "is it actually ready?" from commit logs.

## ✅ Verified in this codebase (tests + live checks)

| Area                          | Status               | Evidence                                                                                                                                                                              |
| ----------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inbound email pipeline**    | ✅ proven end-to-end | `inbound.int-spec.ts` (Testcontainers): real MIME → CLIENT ticket (EMAIL), dedup on re-delivery, In-Reply-To threading, spawn → linked SUPPLIER ticket pair. 12/12 integration green. |
| Inbound transport — webhook   | ✅                   | `POST /api/inbound/pipe` (`x-inbound-secret`), shares `ingestRawMessage` with the IMAP poller.                                                                                        |
| Inbound transport — IMAP poll | ✅ code + unit tests | UID watermark in `Setting`, survives restart; enabled non-IMAP queues are warned, not silently dropped.                                                                               |
| Loop / bounce protection      | ✅                   | Outbound `Auto-Submitted`; inbound skips Auto-Submitted/Precedence/X-Loop/self-from; workflow re-entry depth guard.                                                                   |
| Mass-assignment / RBAC guards | ✅                   | B1/B2/B3 — creationMode/ipAddress stripped, group-privilege + last-admin guards, tests.                                                                                               |
| Scale (indexes, caches, N+1)  | ✅                   | C1–C5 — refresh-token caps + indexes, search guard, SLA batch-load, workflow cache, CustomField cache, GIN trgm indexes (EXPLAIN-confirmed).                                          |
| Per-account login lockout     | ✅                   | D2 — `failedLoginAttempts`/`lockedUntil`, tests.                                                                                                                                      |
| Attachment safety             | ✅ (AV deferred)     | D6 — extension denylist + magic-byte + MIME allowlist. ClamAV is a documented hook, not yet wired.                                                                                    |
| Public-endpoint field leakage | ✅                   | D7/D9 — public projections + list customFields decryption.                                                                                                                            |
| CSP on web                    | ✅                   | D1 — verified served on `next start`.                                                                                                                                                 |
| DB backup → restore           | ✅ cycle proven      | `pg_dump -Fc                                                                                                                                                                          | gzip`→`pg_restore`into a scratch DB reproduced exact row counts (1366 tickets / 1407 users / 11 orgs). Scripts:`scripts/db-backup.sh`, `scripts/db-restore.sh`, runbook `docs/BACKUP.md`. |
| Secret gate (prod)            | ✅                   | `assertProductionSecrets` rejects default/weak JWT + webhook secrets at boot.                                                                                                         |
| Graceful shutdown             | ✅                   | D3 — `enableShutdownHooks()`.                                                                                                                                                         |
| Self-gate                     | ✅                   | `tsc` + `eslint` clean; **610 unit tests** green; **12 integration tests** green.                                                                                                     |

## 🙋 USER-LATER — needs real values / infrastructure at go-live

These are **deliberately not** in the codebase (build + test was done on local containers /
placeholders). Substitute real values and flip the switch:

| Item                    | What to provide                                                                       | Where                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Real `noc@` mailbox     | IMAP host/user/app-password **or** an MTA pipe that POSTs to `/api/inbound/pipe`      | `EmailQueue` row (`isEnabled=true`) / `TELECOM_HD_INBOUND_WEBHOOK_SECRET` |
| A real IMAP server test | GreenMail/Dovecot container (optional — the webhook proves the same pipeline)         | n/a                                                                       |
| MX / DNS                | Mail routing for the support domain                                                   | DNS                                                                       |
| TLS certificate         | Real cert/domain for the reverse proxy                                                | `infra/caddy` or `infra/nginx`                                            |
| Production secrets      | Strong `TELECOM_HD_JWT_*`, `*_WEBHOOK_SECRET`, `TELECOM_HD_FIELD_ENCRYPTION_KEY`      | `.env.prod` (gitignored)                                                  |
| Bootstrap admin         | Strong `TELECOM_HD_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` (the seed refuses weak/`demo1234`) | `.env.prod`                                                               |
| SMTP relay              | Authenticated outbound relay creds                                                    | `TELECOM_HD_SMTP_*`                                                       |

## ⏭️ Knowingly deferred (tracked, not blocking the audit)

- **Alaris module** — 🙋 USER will rewrite it; left untouched (stub).
- **SLA pause/resume** for on-hold tickets (needs a schema column + clock-subtraction).
- **ClamAV** attachment scanning (hook documented in `attachments.service.ts`).
- **Cookie-only auth** (stop returning the raw token in the login/refresh body) — coordinated
  FE change; tokens are already also set as HttpOnly cookies.
- **Nonce-based CSP** `script-src` tightening (Next App Router inline scripts).
- **Inbound dedup atomicity** — dedup is a check-then-act on `Message-ID`; a rare
  concurrent IMAP-poll + webhook re-delivery of the same message could still double-create.
  Hardening = a partial-unique index on non-empty `messageId` + insert-catch.
- **Workflow re-entrancy guard** conflates concurrency with recursion depth — 5+ genuinely
  concurrent events on one hot ticket could hit the cap and skip a run. Needs a proper
  re-entrancy token vs a shared counter.
- **Merge** does not re-parent `TicketRecipient`/tags/`TicketLink`/time-entries onto the
  surviving ticket (product decision — flag for spec confirmation).
- **Workflow auto-assign** (`WorkflowExecutor`) doesn't skip a disabled assignee the way the
  manual `assign` path does (low impact — mail still goes to the intended staff).
