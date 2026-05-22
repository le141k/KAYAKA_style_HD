# ADR 0004 — Auth: JWT access/refresh + argon2 + RBAC permission guards

- Status: Accepted
- Date: 2026-05-22

## Context

Kayako used DB-backed sessions (`swsessions`), legacy password hashes (`islegacypassword`),
and a ~250-key permission EAV (`swstaffgroupsettings`). We need stateless API auth and a
typed permission model.

## Decision

- **Passwords**: argon2id (`argon2` lib). Legacy Kayako hashes are not imported (clean start);
  if a migration is ever done, flag legacy rows and force reset.
- **Tokens**: short-lived JWT **access** token (15m) + long-lived **refresh** token (30d).
  Refresh tokens are persisted **hashed** (argon2) in `RefreshToken` and rotated on use;
  logout revokes. Secrets from `TELECOM_HD_JWT_*`.
- **RBAC**: a typed permission catalog (`apps/api/src/auth/permissions.ts`). `StaffGroup`
  holds `permissions: string[]`; `isAdmin` groups bypass checks. Routes are protected with
  `@RequirePermissions(...)` → `JwtAuthGuard` + `PermissionsGuard`. Public routes use `@Public()`.

## Consequences

- Stateless, horizontally scalable API; revocation handled via the refresh-token table.
- Permissions are discoverable in code and enforced uniformly; the admin RBAC matrix UI maps
  groups → permission keys.
