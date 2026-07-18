# Attachment security and lifecycle

## Current flow

- Staff, anonymous and verified-client HTTP uploads use disk-backed Multer quarantine under
  `TELECOM_HD_UPLOAD_DIR`; file bodies are not buffered in the API heap.
- Anonymous upload requires the `TELECOM_HD_PUBLIC_UPLOAD_ENABLED` switch and an action-bound
  `public-upload` Turnstile token. Verified-client upload requires a valid client session and the
  independent `TELECOM_HD_CLIENT_UPLOAD_ENABLED` switch. Turning either upload switch off returns
  404 before Multer reads request bytes.
- Public/client guards require a fixed `Content-Length`, reject transfer-encoding, enforce the
  request-envelope cap, and consume Redis request/byte quotas before the upload interceptor runs.
- `AttachmentsService` rechecks actual file count and bytes for every caller, verifies extension,
  MIME and magic bytes, rejects archive containers, scans each quarantine file with ClamAV, then
  adopts the bytes and creates all rows in one database transaction.
- Anonymous/client uploads return a UUID claim token. Ticket creation/reply consumes that token when
  adopting orphan rows, preventing attachment-ID guessing and replay.

## Capacity and cleanup

- `TELECOM_HD_ORPHAN_ATTACHMENT_MAX_COUNT` and
  `TELECOM_HD_ORPHAN_ATTACHMENT_MAX_SIZE_MB` are absolute database-backed limits shared by all
  unclaimed upload channels. An advisory transaction lock serializes the final aggregate check and
  orphan-row creation across API replicas.
- `TELECOM_HD_UPLOAD_MIN_FREE_DISK_MB` is checked before public/client Multer admission and again
  before adoption. Storage/DB/statfs failures fail closed with a generic 503.
- Unclaimed rows older than `TELECOM_HD_ORPHAN_ATTACHMENT_TTL_HOURS` are deleted through a durable
  `.deletion-queue`: bytes move out of downloadable storage before the row is deleted and are either
  finalized after commit or restored after rollback/crash.
- Cleanup runs every five minutes without overlapping itself. Staged recovery, quarantine scanning
  and orphan-row deletion are bounded by `TELECOM_HD_ATTACHMENT_CLEANUP_MAX_ITEMS` and a shared
  `TELECOM_HD_ATTACHMENT_CLEANUP_MAX_RUN_SECONDS` deadline; directory reads are streamed.

## Default limits

| Boundary                         | Default |
| -------------------------------- | ------: |
| Per file                         |  25 MiB |
| Aggregate file bytes             |  50 MiB |
| Public/client multipart envelope |  51 MiB |
| Inbound message                  |  35 MiB |
| Files per public/client request  |       5 |
| Files per staff/inbound request  |      10 |
| Outstanding orphan rows          |   2,000 |
| Outstanding orphan bytes         |   2 GiB |
| Minimum free upload-volume space |   5 GiB |

Production also requires the private ClamAV Compose profile. Scanner outage, stale signatures,
capacity-database failure or filesystem-stat failure never produces an adoptable attachment.

## Go-live evidence still required

Code-level unit/type checks do not replace the production load test. Before public enablement, prove
the configured upload concurrency, API/scanner peak memory, zero OOMKills, disk alerts, cleanup
throughput, storage reconciliation and the public/client kill-switch rollback on the target VM.
