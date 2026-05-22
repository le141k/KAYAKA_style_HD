# ADR 0001 — Rewrite Kayako Classic on NestJS + Next.js + PostgreSQL

- Status: Accepted
- Date: 2026-05-22

## Context

The legacy product is Kayako Classic / Fusion v4.93.13 ("Case"), PHP on the proprietary
"SWIFT" framework: a God-object service locator, filesystem routing, `eval()`-based hook
extension system, destructor-time model persistence, raw string-concatenated SQL, and an
`mcrypt`-based license gate that pins it to PHP ≤ 7.1. The framework core is unmaintainable
and not worth porting; the value is the domain model and behavior.

## Decision

Rewrite as a **modular monolith**:
- **Backend**: Node 22 + TypeScript (strict), NestJS (DI, modules, RBAC guards), Prisma over
  PostgreSQL 16, Redis + BullMQ for background work, Pino logs, Swagger docs.
- **Frontend**: Next.js 15 App Router + Tailwind + shadcn/ui, fully rewritten (the Dwoo
  themes are not carried over).
- Three interfaces (client / staff / admin) as App Router route groups against one API.

## Consequences

- Clean separation, testability (Vitest/Testcontainers/Playwright), modern DX.
- We must re-derive behavior from the original schema + PHP as a reference, not port code.
- A modular monolith keeps deployment simple now; modules are isolated enough to extract to
  services later if needed.
