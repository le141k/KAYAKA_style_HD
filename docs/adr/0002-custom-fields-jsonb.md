# ADR 0002 — Custom fields as JSONB, not EAV

- Status: Accepted
- Date: 2026-05-22

## Context

Kayako stored custom field values in an EAV table (`swcustomfieldvalues`: customfieldid +
typeid + fieldvalue + isserialized + isencrypted), with similar EAV for settings and the
~250-key staff permission set. EAV is hard to query, type, and index.

## Decision

- **Field definitions** are relational metadata: `CustomFieldGroup` + `CustomField`
  (with `fieldKey`, `type`, `options`, `isRequired`, `isEncrypted`).
- **Field values** live in a `customFields` **JSONB** column on the owning entity
  (`Ticket`, `User`, `Organization`). Keys are the stable `fieldKey`s.
- Settings use a small `Setting(section, key, value Json)` table.
- Staff permissions are a typed string[] of permission keys on `StaffGroup` (see
  `apps/api/src/auth/permissions.ts`), replacing the permission EAV.

## Consequences

- Values are queryable via Postgres JSONB operators and GIN indexes when needed.
- Encrypted fields (`isEncrypted`) are encrypted at the application layer before storage.
- Migration from Kayako must pivot EAV rows into the JSONB object per entity.
