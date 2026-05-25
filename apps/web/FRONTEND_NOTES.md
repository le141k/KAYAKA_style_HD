# 23 Telecom Help Desk — Frontend Notes

## Project Structure

```
apps/web/
├── app/
│   ├── layout.tsx                  # Root layout: fonts, providers, Toaster
│   ├── globals.css                 # Tailwind layers + all theme tokens (HSL vars)
│   ├── page.tsx                    # Redirects → /kb
│   ├── (client)/                   # Customer portal (no auth required)
│   │   ├── layout.tsx              # Simple header + footer
│   │   ├── login/page.tsx          # → LoginScreen premium component
│   │   ├── submit/                 # New ticket form (RHF+Zod)
│   │   ├── tickets/                # My tickets list + [id] detail
│   │   └── kb/                     # Knowledge base browse + [slug] article
│   ├── (staff)/staff/              # Agent workspace (authenticated)
│   │   ├── layout.tsx              # App shell: SidebarNav + topbar + ⌘K + Bell
│   │   ├── dashboard/              # AnimatedStatCards + recent tickets
│   │   ├── tickets/                # List view (j/k nav) + [id] detail
│   │   └── kanban/                 # KanbanBoard with framer-motion Reorder
│   └── (admin)/admin/              # Settings hub
│       ├── layout.tsx              # Tab navigation
│       ├── departments/            # CRUD table
│       ├── statuses/               # Status + priority display
│       ├── sla/                    # SLA plan table
│       ├── workflows/              # Empty state (placeholder)
│       ├── staff/                  # Staff table with role badges
│       ├── custom-fields/          # Empty state (placeholder)
│       └── alaris/                 # "Coming soon" + disabled placeholder form
├── components/
│   ├── ui/                         # shadcn/ui hand-written components
│   │   ├── button, input, textarea, label
│   │   ├── card, badge, separator, skeleton, avatar
│   │   ├── dialog, dropdown-menu, popover, select, tabs, tooltip
│   │   ├── scroll-area, command (cmdk)
│   │   ├── form (RHF wrappers), table
│   │   └── toast, toaster, use-toast
│   └── premium/                    # Rich/animated components (10+)
│       ├── AnimatedStatCard.tsx    # Count-up + SVG sparkline + gradient bar
│       ├── TicketRow.tsx           # Status dot + priority + avatar + SLA + hover
│       ├── StatusBadge.tsx         # Animated status transitions (framer-motion)
│       ├── PriorityChip.tsx        # Color-coded priority pill
│       ├── SlaPill.tsx             # ok/warn/breach with icons + pulse on breach
│       ├── KanbanBoard.tsx         # framer-motion Reorder, drag-glow shadow
│       ├── CommandPalette.tsx      # ⌘K fuzzy nav + ticket search overlay
│       ├── SidebarNav.tsx          # Collapsible, active-route motion indicator
│       ├── LoginScreen.tsx         # Split layout + animated SVG logo + RHF+Zod
│       ├── FileUploadZone.tsx      # Drag-drop with progress simulation
│       ├── NotificationBell.tsx    # Badge count + shake + popover list
│       ├── SkeletonLoaders.tsx     # TicketList, Dashboard, TicketDetail, Kanban
│       ├── ThemeToggle.tsx         # Animated sun/moon with framer-motion
│       └── LocaleSwitcher.tsx      # ru/en/uk dropdown
├── lib/
│   ├── api.ts                      # fetch wrapper (bearer token, ApiError)
│   ├── types.ts                    # All TypeScript types
│   ├── utils.ts                    # cn, formatDate, formatRelative, etc.
│   ├── mock-data.ts                # Typed mock data for API fallback
│   ├── providers.tsx               # QueryClient + ThemeProvider + I18n + Auth
│   ├── auth/auth-context.tsx       # AuthProvider + useAuth hook
│   └── hooks/
│       ├── use-tickets.ts          # useTickets, useTicket, useReplies, useCreateTicket, useReply, useDashboardStats
│       ├── use-auth.ts             # useMe, useLogin, useLogout
│       └── use-kb.ts               # useKBCategories, useKBArticles, useKBArticle
│   └── i18n/
│       ├── ru.ts, en.ts, uk.ts     # Dictionaries
│       └── index.ts                # I18nContext + useI18n
├── e2e/
│   ├── ticket-submit.spec.ts       # Form validation + submission flow
│   ├── staff-login.spec.ts         # Login form validation + password toggle
│   ├── kanban.spec.ts              # Board render + card click + drag
│   └── kb-search.spec.ts           # Search filtering + article navigation
└── playwright.config.ts
```

## Premium Components (10+)

| Component          | Feature highlights                                                     |
| ------------------ | ---------------------------------------------------------------------- |
| `AnimatedStatCard` | count-up via rAF, SVG sparkline, gradient top-bar, hover lift          |
| `TicketRow`        | status dot, priority chip, assignee avatar, SLA pill, j/k keyboard nav |
| `StatusBadge`      | framer-motion AnimatePresence on status change, ping pulse for open    |
| `KanbanBoard`      | framer-motion Reorder, drag-glow box-shadow, column counts             |
| `CommandPalette`   | ⌘K / Ctrl+K, cmdk fuzzy search, ticket results, kbd hints              |
| `SidebarNav`       | collapsible with width animation, active-route layoutId glow           |
| `LoginScreen`      | split layout, animated SVG broadcast-arcs logo, RHF+Zod                |
| `FileUploadZone`   | drag-drop visual states, per-file progress bar simulation              |
| `NotificationBell` | badge count, shake animation on new notification, popover list         |
| `SkeletonLoaders`  | TicketList, Dashboard stats, TicketDetail, Kanban skeleton sets        |
| `SlaPill`          | ok/warn/breach states, breach pulse animation                          |
| `PriorityChip`     | CVA-based color variants per priority                                  |
| `ThemeToggle`      | framer-motion rotate transition between sun/moon icons                 |
| `LocaleSwitcher`   | ru/en/uk dropdown, updates I18nContext                                 |

## Design System

- **Tokens**: All from `frontend/styles/theme/tokens.css` — copied verbatim into `globals.css`
- **Colors**: HSL CSS vars consumed via Tailwind config (no hard-coded hex)
- **Typography**: Inter (UI) + JetBrains Mono (ticket IDs, code) via next/font
- **Dark mode**: `class` strategy via next-themes, all components dark-mode parity
- **Accessibility**: focus-visible rings (`--ring`), aria-labels, aria-current, role=list, sr-only, aria-busy

## API Integration

> **Corrected 2026-05-25:** the mock-data fallback was **removed** during hardening — hooks now
> surface real API errors (no `lib/mock-data.ts` import remains; the orphan file is unused).
> Screens require a running backend. (Historical note retained below.)

~~All React Query hooks gracefully fall back to `lib/mock-data.ts` when the API returns an error.~~

Endpoints wired:

- `POST /auth/login` · `GET /auth/me`
- `GET /tickets` · `GET /tickets/:id` · `POST /tickets` · `PATCH /tickets/:id`
- `POST /tickets/:id/reply` · `GET /tickets/:id/replies`
- `GET /dashboard/stats`
- `GET /kb/categories` · `GET /kb/articles` · `GET /kb/articles/:slug`

## TODOs / Needs Install to Run

1. `npm install` inside `apps/web/` to install all deps
2. Create `.env.local`:
   ```
   NEXT_PUBLIC_API_URL=http://localhost:4000
   ```
3. The tsconfig extends `../../tsconfig.base.json` — verify module resolution is `Bundler` (overridden in apps/web/tsconfig.json)
4. `date-fns` import used in one file — add to deps or replace with custom formatter (already have `formatDate` in `lib/utils.ts`, switch to that)
5. KanbanBoard uses `framer-motion` Reorder — verify framer-motion ≥ 10.16 is installed
6. Playwright tests: run `npx playwright install` before `npm run test:e2e`
7. ~~Auth guard middleware (`middleware.ts`) — not created~~ **DONE:** `apps/web/middleware.ts` exists and guards `/staff/*` and `/admin/*`.
8. `@radix-ui/react-accordion` and `@radix-ui/react-collapsible` included in package.json but not yet used — can be removed if not needed
9. Admin route tabs use static `href` matching for `data-[active]` — wire with `usePathname()` in a client component wrapper if needed
10. Real file upload: `FileUploadZone` simulates progress; wire to `POST /tickets/:id/attachments` with `multipart/form-data`

## Typecheck fixes

Changes made to bring `tsc --noEmit` from ~150+ errors to 0:

1. **`lib/i18n/ru.ts`** — Removed `as const` from the `ru` object. Previously `typeof ru` used narrow string-literal types (e.g. `"Загрузка..."`), which caused `en.ts` and `uk.ts` to fail because their translated strings didn't match the Russian literals. Without `as const`, `typeof ru` uses broad `string` leaf types, so all three dictionaries satisfy `Dictionary` without errors.

2. **`app/(client)/tickets/[id]/client-ticket-detail.tsx`** — Added type parameter to `useForm`: changed `useForm({…})` to `useForm<ReplyForm>({…})` (where `type ReplyForm = { body: string }` is declared inline). This aligns the inferred `SubmitHandler` type with the `onSubmit` handler's parameter type, resolving the `TS2345` incompatibility.

3. **`next.config.mjs`** — Added `output: "standalone"` so the Next.js build produces a self-contained output directory, as expected by the Docker image.
