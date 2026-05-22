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

## 2026-05-22 — Security hardening

- **No fallback secrets**: `TELECOM_HD_JWT_ACCESS_SECRET` and `TELECOM_HD_JWT_REFRESH_SECRET`
  are now validated as `z.string().min(32)` with no `.default(...)`. The app fails fast at boot
  if either is absent or shorter than 32 characters.
- **Guard reads config via DI**: `JwtAuthGuard` now injects `AppConfig` via `@Inject(APP_CONFIG)`
  and uses `config.TELECOM_HD_JWT_ACCESS_SECRET` for token verification, removing the
  `process.env ?? 'change-me-access-secret'` fallback that was previously in the guard.
- **Timing-safe webhook secret comparison**: `AlarisController` now uses Node's
  `timingSafeEqual` (from `node:crypto`) when validating the `x-alaris-secret` header,
  guarding against timing-oracle attacks. A length pre-check ensures no exception is thrown
  on mismatched buffer sizes.
