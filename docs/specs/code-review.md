# Deep Code Review — backend (post-fix re-audit worklist)

## P0 — critical bugs / security

- **P0-1** `GET /tickets/my?email=` (@Public) leaks any user's ticket list by email — no ownership proof. tickets.controller.ts:83 / service:195. Fix: signed magic-link/OTP or require ticket mask.
- **P0-2** `GET /tickets/public/:id` returns full Prisma row (ownerStaffId, slaPlanId, ipAddress, messageId, user.emails) + sequential-int enumeration. tickets.service.ts:235. Fix: use mask not int id; whitelist safe fields.
- **P0-3** `POST /tickets/public/:id/reply` accepts arbitrary `requesterEmail` → impersonation. tickets.service.ts:264. Fix: validate against ticket.requesterEmail or drop field.
- **P0-4** `UpdateStaffGroupSchema = CreateStaffGroupSchema.partial()` allows `PATCH /staff/groups/:id {isAdmin:true}` → privilege escalation (agents have STAFF_MANAGE). staff/dto.ts:10. Fix: omit isAdmin/permissions from update or admin-only gate.
- **P0-5** ticket create uses `mask:'TT-PENDING'` then 2nd update → visible window + stuck-on-crash (unique mask → P2002). Same in split(). tickets.service.ts:103,723. Fix: single $transaction or sequence-based mask.

## P1 — logic/data integrity

- **P1-1** SLA `runPeriodicCheck` re-fires escalation rules (add_note + notify emails) every 60s forever — no idempotency. sla.service.ts:214. Fix: TicketEscalationFired table or window-bound threshold.
- **P1-2** `merge()` re-parents only posts, NOT notes/attachments/watchers → orphaned on source delete. tickets.service.ts:648. Fix: include in $transaction.
- **P1-3** `publicReply`/`reply` from USER on resolved ticket doesn't reopen it → customer reply invisible. tickets.service.ts:264,432. Fix: reset to pending on USER reply when isResolved.
- **P1-4** `users.addEmail` demote+create not in transaction (TOCTOU). users.service.ts:149. Fix: $transaction.
- **P1-5** `staff.update` department deleteMany+createMany+update not atomic. staff.service.ts:128. Fix: $transaction.
- **P1-6** `inbound.service` fetch('1:_') every poll → re-creates tickets/dup posts (no UID watermark). inbound.service.ts:124. Fix: persist highest UID per queue in Setting, fetch lastUid+1:_.
- **P1-7** `dashboard()` findMany of ALL responded tickets into memory for avg. reports.module.ts:92. Fix: $queryRaw AVG(EXTRACT(EPOCH...)).
- **P1-8** `run()` passes stored report.definition as Prisma where without re-validation. reports.module.ts:63. Fix: DefinitionSchema.safeParse before execute.
- **P1-9** Alaris secret compare uses .length (UTF-16) not byteLength; empty expected → accepts any. alaris.controller.ts:43. Fix: Buffer.byteLength + reject empty.

## P2 — quality/dead code

- **P2-1** N+1 in SLA scan (per-ticket rule/staff/mail/update); checkBreaches no take cap. sla.service.ts:214.
- **P2-2** WorkflowExecutor ignores `_eventName` → all workflows fire on every event. workflow.executor.ts:58. Fix: triggerOn[] field.
- **P2-3** auto-close sends `autoresponder` template ("ticket created") on close. auto-close.processor.ts:97. Fix: ticket_auto_closed template.
- **P2-4** split() creates ticket outside its $transaction → phantom TT-PENDING on tx fail. tickets.service.ts:723.
- **P2-5** KB getArticleBySlug increments view unconditionally, no debounce. knowledgebase.service.ts:91.
- **P2-6** JWT perms trusted for full TTL (15min) after revocation (refresh re-loads). Document or shorten TTL.
- **P2-7** mailService.sendTemplate vars typed string but large HTML passed; {{ }} injection risk if user-controlled subject + wrong template. mail.service.ts:104.
- **P2-8** inbound reply always authorType USER even if staff emails in. inbound.service.ts:176.
- **P2-9** NewsModule: model exists, NO controller/service/dto — dead.
- **P2-10** TroubleshooterModule: models exist, NO service/controller — dead.
- **P2-11** reports run() 404 message loses context ("Resource not found" vs "Report N").
- **P2-12** auth refresh() O(N) argon2 over all active tokens; jti unused. auth.service.ts:85. Fix: store indexed jti, look up one row.

## Schema risks

- totalReplies denormalized counter can drift (merge doesn't count moved notes).
- Department.parentId onDelete default SetNull (children silently become root).
- Status/Priority/Type FK onDelete Restrict → delete-in-use throws (now 400 via filter) — better UX = check+clear message.
