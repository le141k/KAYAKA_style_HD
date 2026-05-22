# Build progress — 23 Telecom Help Desk

Living status doc for the rewrite. Updated as milestones complete.

## Done
- [x] Brand identity (`docs/brand/`): guidelines, palette (telecom blue/cyan/indigo + status),
      typography (Inter / JetBrains Mono), tone of voice ru/en/uk, SVG logo + mark.
- [x] Theme (`frontend/styles/theme/`): shadcn HSL tokens (light/dark) + status tokens,
      `tailwind-preset.ts`, `theme.json`.
- [x] Monorepo backbone: npm workspaces, `tsconfig.base.json`, ESLint/Prettier/EditorConfig,
      `.gitignore`, `.env.example` (TELECOM_HD_*), `docker-compose.yml`, GitHub Actions CI.
- [x] Prisma schema (`apps/api/prisma/schema.prisma`): normalized domain — staff/RBAC, users,
      orgs, departments, tickets (+posts/notes/attachments/watchers/tags/audit/links/merge),
      statuses/priorities/types, SLA (plans/schedules/holidays/escalation), workflows/macros,
      mail (queues/templates), custom fields (metadata + JSONB values), KB, news, settings,
      Alaris stub.
- [x] API bootstrap pieces: config (zod-validated env), PrismaService/Module, ZodValidationPipe,
      RBAC permissions catalog + auth decorators/contracts.
- [x] Dockerfiles (api, web multi-stage), k6 load script, ADRs (0001–0005), README, packages/shared.
- [x] Infra up locally: Postgres 16, Redis 7, MailHog (docker compose).

## Done (verified this session)
- [x] Backend modules: auth (JWT+argon2+RBAC), base (staff/users/orgs/departments), tickets
      (full lifecycle), alaris stub, sla, mail, knowledgebase, news, troubleshooter, reports.
- [x] Frontend: Next.js 15 app, 17 shadcn + 14 premium components, 3 interfaces, i18n ru/en/uk,
      Playwright specs. `next build` 18 pages, lint clean.
- [x] `npm install` · `prisma migrate dev` ×2 · `prisma generate`.
- [x] Typecheck api + web → 0 errors. Vitest unit **25/25 passing**.
- [x] Seed demo data. API boots; Swagger at /api/docs (49 paths).
- [x] Live smoke: login ✅, public ticket ✅ (TT-000006), alaris webhook ✅ (TT-000007).
- [x] Extended runtime checks: reports/dashboard, troubleshooter, kb, news → 200.
- [x] Fixed login contract mismatch (accessToken/staff), AuthModule global (DI), Dockerfile
      workspace manifests, app.module registration of reports/troubleshooter.
- [x] Screenshots of all 3 interfaces (`docs/screenshots/`). Docs filled (endpoints/internal/
      architecture via docs-keeper). FINAL_REPORT.md.

## In progress / pending
- [~] `docker compose build` (api+web images) — running under amd64 emulation.
- [ ] Run integration (Testcontainers) + E2E (Playwright) + k6 suites in CI (specs/scripts provided).
- [ ] BullMQ wiring (SLA scan), workflow engine executor, attachment upload, full KQL — TODO (see FINAL_REPORT).

## Known constraints / decisions
- SWIFT framework core dropped; only domain + schema carried over (ADR-0001).
- Custom fields → JSONB, not EAV (ADR-0002). Attachments by storage key (ADR-0003).
- Alaris is a stub (ADR-0005): webhook → ticket only.
- 21st.dev premium components: no account/API access, so equivalent rich components are
  hand-built on shadcn + Framer Motion in the same visual spirit.
