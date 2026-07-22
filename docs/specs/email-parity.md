# Implementation Spec — Email fidelity parity (CC/BCC, parser rules, IMAP password, notifications)

## A [P0] CC/BCC recipients (3882 prod rows lost on migration)

- schema: `enum RecipientRole{CC,BCC}` + `model TicketRecipient{id,ticketId(onDelete Cascade),email,role,addedAt @@unique([ticketId,email])}` + `recipients[]` on Ticket. Migration `20260524_email_parity`.
- dto: add `ccEmails/bccEmails: z.array(z.string().email())` to CreateTicketSchema + ReplyTicketSchema.
- MailService: add `cc?/bcc?` to SendMailOptions + thread into transporter.sendMail + sendTemplate.
- TicketsService.createTicket: createMany TicketRecipient from cc/bcc; reply (staff): load recipients → pass cc/bcc to sendTemplate; getTicket include recipients.
- recipients.controller.ts: POST/GET/DELETE /tickets/:id/recipients (TICKET_EDIT).
- migration mapping: swticketrecipients JOIN swticketemails; recipienttype 1→CC 2→BCC.

## B [P0] Email parser rules (10 prod rules; inbound routing/ignore lost)

- schema: `EmailParserRule{id,title,ruleType(PRE/POST_PARSE),matchType(ALL/ANY),stopProcessing,isEnabled,sortOrder,criteria Json,actions Json}`.
- parser-rule.types.ts: ParserCriterion{field:subject|sender|sendername|recipient|body, op:contains|not_contains|eq|starts_with|ends_with|regex, value} ; ParserAction{type:ignore|route_dept|set_priority|assign_staff|add_tag, value}.
- inbound.service: applyParserRules(parsed,deptId)→{skip,departmentId,priorityId?,ownerStaffId?,tags[]} evaluated before threading; skip→discard (no ticket); else pass overrides to createTicket. evaluateCriteria(ALL/ANY)+extractField.
- admin CRUD parser-rules.controller (`mail.configure`): GET/POST/PATCH/DELETE /admin/parser-rules + /reorder.
- migration: swparserrules + swparserrulecriteria(ruleop 1eq/3contains/4not_contains/5starts/6ends/7regex) + swparserruleactions(setdepartment→route_dept etc).

## C [P0] IMAP password encryption (prod queues fail auth today; inbound.service.ts:57 TODO passes ciphertext)

- common/field-encrypt.util.ts: AES-256-GCM, format `v1:<ivHex>:<tagHex>:<ctHex>`; legacy (no v1:) returns as-is (rolling migration).
- config: `TELECOM_HD_FIELD_ENCRYPTION_KEY` (64 hex, required in production; dev/test may omit).
  The deploy helper converts legacy plaintext `EmailQueue.passwordEnc` values while workers are paused,
  validates existing `v1:` ciphertext with that key, and fails closed on a malformed value.
- email-queue.service: encryptField on create/update password→passwordEnc.
- inbound.service:57: `pass: decryptField(queue.passwordEnc, key)`.
- `seed/reencrypt-email-queue-passwords.ts` is the idempotent deployment gate (CAS updates plus a final
  aggregate-only verification); it is run by `scripts/deploy-prod.sh` before new API startup.

## D [P1] Staff notifications

- Assignment, customer-reply watcher alerts and SLA alerts are immutable
  `INTERNAL_NOTIFICATION` outbox commands, never direct `sendTemplate()` calls.
- `TicketsService.assign` creates its assignment audit and command in one transaction;
  a customer reply uses its `TicketPost` id as the watcher-command source. Workflow
  assignment uses the same transactional helper. SLA uses a unique
  `SlaEscalationEvent` under a serializable fence.
- Five mandatory production templates (`autoresponder`, `ticket_auto_closed`,
  `notify_staff_assigned`, `notify_staff_user_replied`, `sla_breach_internal`) are
  seeded by migration and verified non-empty by `scripts/deploy-prod.sh`.

## Tests

mail.service (cc/bcc), tickets (recipient upsert + assign-notify), inbound.service (evaluateCriteria ALL/ANY/regex, applyParserRules skip/route/stop, processMessage discard), parser-rules.service CRUD, field-encrypt.util (roundtrip, tamper throws, legacy passthrough, wrong key), notification.service.

## Priority

P0: IMAP decrypt (1 file+util), CC/BCC schema+send, parser 'ignore' action (junk-ticket prevention). P1: parser route/priority/assign + admin CRUD, assign/watcher notify, CC/BCC admin endpoint. P2: NotificationRule engine.
