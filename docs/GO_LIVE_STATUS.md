# GO-LIVE STATUS — 23 Telecom Help Desk

_Last updated: 2026-07-18. The release-candidate implementation is code-complete, but the public
GO gate is **not** complete. Keep the application internal/allowlisted until the VM and edge
evidence below is recorded. The authoritative checklist is `docs/GOAL_PUBLIC_SECURITY.md`._

## Code-complete in the release candidate

| Area               | Implemented evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staff browser auth | Cookie-only login/refresh; production `__Host-th_access`, `__Host-th_refresh` and `__Host-th_csrf` cookies at `Path=/`; exact-origin plus signed double-submit CSRF; atomic refresh-family rotation and immediate `authVersion` invalidation. JWTs are not returned to browser code.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Password reset     | Generic responses, Redis abuse limits, strict mail delivery, fragment tokens, atomic single-use consume, enabled/version checks and session/reset revocation on security changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Client portal      | Generic asynchronous magic-link request, single-use token, revocable `__Host-th_client` session, stable `User.id` ownership and identical 404 responses for wrong-owner/unmapped tickets and attachments. The production feature gate defaults closed.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Inbound mail       | IMAP and webhook share a durable, bounded acceptance/drain path; epoch/generation fencing prevents stale cursor writes; poison messages are retried then quarantined; real Message-ID claims use semantic content while headerless mail stays transport-identity based. A capture-only queue is durably retired before IMAP fetch and cannot be reused for fresh ingress; queue-bound raw-MIME `ACTIVE`/`COMMITTED`/`REAPING` staging blocks that retirement until a bounded safe sweep. Large raw MIME is retained privately in uploads; a short `ACTIVE` publish fence prevents a reaper from deleting the final file during temp-to-atomic-rename hand-off, with bounded cleanup afterwards. |
| Upload safety      | Pre-Multer request limits, disk quarantine, MIME/signature/extension validation, fail-closed ClamAV, independent upload kill switches, bounded quotas/storage reserve and orphan cleanup/reconciliation audits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Database           | Historical evidence: an earlier 31-migration chain applied from zero on disposable PostgreSQL 15, followed by seed and a clean ownership audit. It is **superseded** by the current 51-migration release: a fresh from-zero and restored-production-shaped upgrade proof on the current PostgreSQL image remain mandatory and pending. Identity and Message-ID invariants fail closed on unsafe legacy data.                                                                                                                                                                                                                                                                                    |
| Release operations | Exact fetched-`main` provenance, immutable API/web tags, a derived `NEXT_PUBLIC_*` web-build digest, one-shot first-admin prompt, paused/drained BullMQ cutover, matched DB/uploads backups with disposable restore proof, disposable Redis-clone validation and an owner-only recovery manifest.                                                                                                                                                                                                                                                                                                                                                                                               |
| Local verification | Targeted security suites and API/web typecheck and lint have passed during implementation. Historical numeric test counts are intentionally omitted; the final full release gate must be rerun and attached to the release evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Public GO blockers — live VM/edge evidence required

These are operational gates, not missing application features:

- deploy the exact clean `origin/main` commit internally and pass environment, live-data,
  ownership, template, attachment-storage and scanner audits;
- prove the production-shaped upgrade and matched DB/uploads restore rehearsal; preserve and verify
  the matching Redis rollback volume as the third member of the recovery point;
- confirm no enabled demo/default staff, perform the approved session/reset/webhook/JWT credential
  cutover and prove old values fail without restoring old secrets;
- prove ClamAV signature freshness, EICAR rejection, storage reconciliation, configured upload load,
  disk/RSS thresholds and zero OOMKills on the production VM;
- prove real SMTP plus the approved inbound mailbox/MTA path, forgot-password delivery and a complete
  client magic-link round trip;
- select and document one canonical HTTPS edge, trusted-proxy/client-IP chain and firewall policy;
  prove there is no origin bypass or unexpected public listener with an external scan;
- run the mandatory HTTPS cookie/CSRF/logout smoke, security repro matrix, dependency/image scan,
  staged pilot and monitored soak before opening the edge to the world.

## Operator-supplied production values

Real domain/DNS/TLS topology, SMTP and IMAP/MTA credentials, Turnstile keys, and strong application,
database, Redis, webhook and encryption secrets belong only in the approved VM secret store or
owner-only `.env.prod` as documented in `docs/DEPLOY.md`.

Bootstrap credentials are the exception: they must **not** be stored in `.env.prod`. On a true first
install, `scripts/deploy-prod.sh` invokes `scripts/bootstrap-admin.sh`; the operator enters the email
and strong password interactively for a removed one-shot API container. Existing installations skip
that prompt.

## Unrelated product work

The planned Alaris rewrite, SLA pause/resume semantics, a nonce-only Next.js CSP, workflow hot-ticket
re-entrancy semantics and merge/auto-assign product decisions remain separate backlog items. They do
not replace any public GO evidence above. Inbound logical Message-ID claiming and production malware
scanning are implemented; real PostgreSQL/IMAP cutover evidence is still mandatory.
