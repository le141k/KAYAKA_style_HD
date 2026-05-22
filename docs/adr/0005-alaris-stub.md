# ADR 0005 — Alaris integration is a stub (for now)

- Status: Accepted
- Date: 2026-05-22

## Context

A future requirement is to ingest alarms from Alaris (telecom routing platform) and turn
them into tickets. The full integration (SNMP traps, alarm email parsing, Telegram bridge,
de-duplication, auto-close on clear) is out of scope for this build.

## Decision

Ship a **minimal stub** that proves the seam:
- `POST /api/alaris/webhook` (shared-secret guarded) accepts a synthetic event.
- It de-duplicates by `externalId` and auto-creates a ticket of type *Alaris Incident*,
  subject prefixed `[ALARIS-AUTO]`, `creationMode=ALARIS`, `creator=SYSTEM`.
- The admin UI exposes an "Alaris Integration" tab with a non-functional "Coming soon"
  thresholds form.
- `apps/api/src/seed/generate-fake-alaris-event.ts` posts a demo event.

## Consequences / TODO (future)

- SNMP trap listener, alarm-email parser, severity→priority mapping, de-dup windows,
  auto-close on alarm clear, Telegram/Slack notification, threshold configuration.
