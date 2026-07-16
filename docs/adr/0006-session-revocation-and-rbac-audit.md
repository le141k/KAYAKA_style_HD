# ADR 0006 — Session revocation on access change + RBAC audit trail

- Status: Accepted
- Date: 2026-07-16

## Context

ADR-0004 gave us stateless JWT auth with rotating, hashed refresh tokens and a typed
permission model. Two gaps remained once Administrators began actively managing staff RBAC:

1. **Stale sessions.** A staff member's access token embeds their `isAdmin` flag and
   `permissions`. After an admin changed a member's role, reset their password, or disabled
   their account, the member's already-issued access token kept working (up to the ~15 min TTL)
   and their refresh token could still mint new ones — the change didn't take effect until the
   tokens naturally expired.
2. **No RBAC audit.** There was no record of who created a staff member, changed a role,
   edited a group's permissions, reset a password, or disabled an account.

We also needed a real **Manager** role (previously every non-admin collapsed to "agent").

## Decision

- **Roles.** Three built-in role templates in `permissions.ts` (`ROLE_TEMPLATES`):
  Administrator (`isAdmin`), Manager (tickets/users/orgs/KB/reports; no `staff.manage`,
  `org.delete`, or `admin.*`), Agent. Served to the UI via `GET /api/staff/rbac`. The prod
  bootstrap creates any missing standard group idempotently, never overwriting existing ones.

- **Session revocation (two layers, matching the two token types):**
  - Refresh tokens → marked `revokedAt` in Postgres (durable; blocks new access tokens).
  - Access tokens → a per-staff Redis cutoff (`th:staffcutoff:<staffId>` = epoch seconds,
    TTL = access-token lifetime). `JwtAuthGuard` rejects any access token whose `iat`
    predates the cutoff. Fail-open if Redis is down (short TTL + refresh revocation are the
    backstops), consistent with the existing jti blocklist.
  - Triggers: `StaffService` role/password/`isEnabled→false` change, and a group
    permission-set change (revokes every member).

- **Last active administrator protection.** Cannot disable/demote the last enabled admin,
  nor delete the last `isAdmin` group (403).

- **RBAC audit.** Append-only `RbacAuditLog` written by `RbacAuditService` on every
  staff/group change; readable at `GET /api/staff/audit` (`staff.manage`). Writes are
  best-effort (a failed audit insert never rolls back the actual change).

- **Permission-aware frontend.** `/auth/me` `permissions` are carried into the web principal;
  navigation and the `/admin` area gate by concrete permissions (via `useAuth().can/canAny`)
  instead of a single `isAdmin` flag, so a Manager sees what they can actually use.

## Consequences

- Access changes take effect immediately (Redis reachable) or within the access TTL (fail-open),
  with refresh revocation always durable.
- One extra Redis read per authenticated request (alongside the existing jti check).
- Every RBAC change is attributable. The audit table is append-only and unbounded — a future
  retention/rotation job may be added if volume warrants.
- Client (`User`) authentication is explicitly **out of scope** here (separate future contour).
