# ADR 0003 — Attachments by storage key, not chunked BLOBs

- Status: Accepted
- Date: 2026-05-22

## Context

Kayako stored attachments either as filesystem files (`storefilename`) **or** chunked across
DB rows (`swattachmentchunks.contents` MEDIUMBLOB, optionally base64). The observed instance
used disk only (`swattachmentchunks` empty).

## Decision

`Attachment` records reference content by a `storageKey` (path/object key) plus `sha1`,
`mimeType`, `size`. Binary content lives in an object store (S3-compatible) or local disk,
never in Postgres. A storage abstraction (local/dev → S3/prod) sits behind the key.

## Consequences

- DB stays small and fast; large mail attachments don't bloat rows.
- Migration reassembles any legacy DB chunks into stored objects and records the key.
