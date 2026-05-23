# NEXT-GOAL WORKLIST — 23 Telecom Help Desk

> ✅ IMPLEMENTED this session (live-verify pending rebuild): **Attachments** (storage/upload/download + inbound email attachments + frontend FileUploadZone real upload + per-post download chips) and **Reports/KQL engine** (safe declarative model + compiler + ReportRun + schedule processor + 10 seed reports + CSV). ALL THREE big parity features now IMPLEMENTED: attachments, reports-KQL, AND email-parity (CC/BCC + parser-rules + IMAP AES-256-GCM encryption + staff notifications). Remaining = P2/P3 long tail only (see below).

> Authoritative, prioritized worklist for the next `/goal` pass. Built from the post-fix
> re-audit (1 coordinator + 14 agents): functional parity vs original Kayako + full
> module bug sweep + deep-dive specs for the big parity features. Every item has a fix
> location. Deep-dive specs live in `docs/specs/{attachments,reports-kql,email-parity,code-review}.md`.
>
> Discipline (same as last pass): fix in priority order → unit/integration tests → tsc/lint
> /vitest green → `docker compose build --no-cache web api` + `up -d --force-recreate` →
> Playwright real-login verify → commit/push. Demo: admin@23telecom.example / demo1234.
> Rate-limit aware (login 5/60s, global 300/60s) when scripting.

---

## P0 — must fix first

> ✅ The 4 last-pass regressions below were FIXED & live-verified (commit pending): first-post dedup (use-tickets slice(1)), staff-create departmentId selector + priority map, workflow UI-vocab alias in executor (verified firing → tag added), applyMacro change_status routed via changeStatus. Kept for history.

### Regressions introduced by the last fix pass (quick, high-value)

- **TD: first post duplicated in thread** — `ticket.body = posts[0].contents` AND `replies` includes posts[0]. Fix `mapTicket` → `t.posts?.slice(1).map(mapPostToReply)`. `apps/web/lib/hooks/use-tickets.ts:158`.
- **Staff create ticket dialog always 400** — no `departmentId` field; API requires it. Add a department `<Select>` (GET /api/departments) + send `departmentId` (+ map priority→priorityId). `tickets-list-content.tsx:28-35,276-330`, `use-tickets.ts:282`.
- **Workflow builder vocab mismatch → workflows silently never fire**: UI criteria ops `{is,is_not,starts_with,ends_with}` vs executor `{eq,neq,contains,gt,lt}`; UI actions `{assign_group,assign_staff,set_status,set_priority,remove_tag,send_email}` vs executor `{change_department,change_owner,change_status,change_priority,add_tag,add_note}`. Align vocab + add remove_tag/send_email handlers. `workflows-content.tsx:70-87`, `workflow.executor.ts:14,80-148`.
- **applyMacro `change_status` bypasses changeStatus()** → isResolved/resolvedAt/SLA not updated. Route through `this.changeStatus()`. `tickets.service.ts:~882,929`.

### Security (see `docs/specs/code-review.md` + security re-audit)

- **AU-4 HttpOnly cookie** (token in localStorage + non-HttpOnly cookie = XSS). Move to server `Set-Cookie HttpOnly;Secure;SameSite` + `credentials:include`; drop JS token mgmt. COUPLE with **Next.js `middleware.ts`** (server route guard for /staff,/admin). `auth.controller`, `api.ts`, `use-auth.ts`, new `apps/web/middleware.ts`.
- **IDOR/leak on public ticket**: `GET /tickets/public/:id` + `POST .../reply` have no ownership check (enumerable by int id) and `user:{include:{emails}}` leaks passwordHash. Require+verify requesterEmail (or per-ticket token); narrow user select; consider mask-based id. `tickets.service.ts:235,242,264`.
- **isAdmin privilege escalation** via `PATCH /staff/groups/:id` (UpdateStaffGroupSchema=Create.partial). Strip isAdmin/permissions from update or admin-only gate. `staff/dto.ts:10`, `staff.service.ts`.
- **APP_GUARD JWT backstop**: add global `JwtAuthGuard`+`PermissionsGuard` so an undecorated route isn't wide open. `app.module.ts`.
- **No rate-limit/ownership on `GET /tickets/my`** (RBAC-2): per-email throttle + field masking now; OTP/magic-link proper.
- **Alaris secret** weak: `z.string().min(32)` + random; alaris missing-fields `timingSafeEqual` byteLength + reject empty.

### Backend 500/data-integrity (code-review.md)

- ticket-create **mask race** (`TT-PENDING` two-write) → single $transaction. `tickets.service.ts:103,723`.
- **merge()** doesn't re-parent notes/attachments/watchers → orphaned. Include in $transaction.
- **IMAP duplicate autoresponder** (createTicket + inbound both send) → remove inbound `sendTemplate`. `inbound.service.ts:241`.
- **IMAP `fetch('1:*')`** every poll → dup tickets. UID watermark in Setting / `{seen:false}`. `inbound.service.ts:124`.

### Parity P0 features (full specs in docs/specs/)

- **Attachments** upload/download/storage end-to-end + inbound email attachments → `docs/specs/attachments.md`.
- **Email parser rules** (`ignore` action prevents bounce-loop junk tickets) + **IMAP password AES-256-GCM** + **CC/BCC** → `docs/specs/email-parity.md`.

---

## P1 — important

- **Reports/KQL engine** (safe declarative model + compiler + schedules + 10 reports + UI) → `docs/specs/reports-kql.md`.
- **Staff/watcher notifications** (notify-on-assign, notify-watchers-on-user-reply) + workflow `send_email` action → email-parity.md §D.
- **TICKET custom fields never rendered** on staff create / client submit (required field blocks API invisibly). Fetch TICKET-scope groups + render dynamic inputs + send customFields.
- **macro isShared** has no DB column (phantom). Add column+dto+service. macro **replyText** has no UI textarea (macros can't auto-reply).
- **publicReply/reply on resolved ticket doesn't reopen** → customer reply invisible. Reset to pending on USER reply.
- **Ticket-detail missing UI** for department change + apply-macro (APIs exist). Add Combobox + macro picker.
- **resolved_today** = all-time not today (reports.module.ts:88, add startOfDay filter); **stat-card links** don't seed list filters from URL (`searchParams`); **sla_breached=1** param ignored.
- **Tickets list**: pagination UI (61 tickets, 25 shown), per-page, department/assignee filters, dead "Фильтры" button, sortable columns.
- **KB**: category-name inverted regression (`a.categoryId ? '' : 'Общее'`); voting/related/TOC missing. **Public departments endpoint** so submit dropdown shows for unauth clients.
- **SLA/troubleshooter list endpoints** 200[] for missing parent → 404. `sla.service.ts:383,454`, `troubleshooter.module.ts:20`.
- **dashboard avg** uses unbounded findMany → `$queryRaw AVG`. reports run() re-validate definition. argon2 refresh O(N)→jti lookup.
- **Saved ticket views**, **follow-ups**, **report schedule execution UI**, **email-queue + template web UI** (APIs exist, no pages).
- **React hydration #418** (formatRelative Date.now) on SSR pages → suppressHydrationWarning or post-hydrate switch.

---

## P2 / P3

- Custom field "number" type → 422 (add NUMBER to enum/map or remove); CF type label raw uppercase; CF field-edit + group-scope + staff-group CRUD UI; select-type options editor.
- Watchers add/remove require TICKET_VIEW→TICKET_EDIT; watcher/ticket delete silent 204; flag endpoint; ticket-link CRUD; search post bodies; reply drafts; time-tracking; user/org notes; POP3; KQL expansion.
- Kanban: 50-cap pagination, onDragLeave flicker, skeleton 4-vs-5; client reply no try/catch; non-numeric ticket id NaN→notFound; useSearchParams Suspense boundary; duplicate id="reply-textarea"; sla_breach template vars; auto-close wrong template; SlaProcessor/MailProcessor debug→info logging; pagination 3 shapes standardize; @ApiResponse schemas; JWT revocation lag (Redis jti blocklist); dead NewsModule/Troubleshooter wiring; attachment fake-progress deceives user.

---

## Confirmed working (do NOT re-touch)

All last-pass fixes verified live: login throttle→429, login→/staff/dashboard, guards, 401-refresh, KB drafts hidden, ticket status/priority/assignee/close/tags/notes/authors, kanban DnD persist, dashboard real metrics, server-side filters, /auth/me real name, apply-macro/dept-change/email-queue endpoints, mail "Hello <name>", Alaris no-autoresponder/400/403/dedup, SLA+auto-close jobs, custom-field validation, admin CRUD (dept/status/priority/staff/workflow/macro/CF create+edit), client portal submit/my-tickets/public-detail/reply. Test suite: api vitest 325/325, web build clean.

---

## Addendum — needs live verification next pass

- **SLA admin UI** (new schedules / holidays / escalation-rules CRUD from this pass) — re-audit agent did not return in time; exercise create/edit/delete on each via the UI and confirm correct seconds/camelCase payloads + nested routes (`/admin/sla/schedules/:id/holidays`, `/admin/sla/plans/:id/escalation-rules`).
- Department parent-selector in admin form (parentId now accepted) — confirm sub-department creation via UI.
