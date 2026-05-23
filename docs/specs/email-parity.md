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
- admin CRUD parser-rules.controller (ADMIN_MAIL): GET/POST/PATCH/DELETE /admin/parser-rules + /reorder.
- migration: swparserrules + swparserrulecriteria(ruleop 1eq/3contains/4not_contains/5starts/6ends/7regex) + swparserruleactions(setdepartment→route_dept etc).

## C [P0] IMAP password encryption (prod queues fail auth today; inbound.service.ts:57 TODO passes ciphertext)

- common/field-encrypt.util.ts: AES-256-GCM, format `v1:<ivHex>:<tagHex>:<ctHex>`; legacy (no v1:) returns as-is (rolling migration).
- config: `TELECOM_HD_FIELD_ENCRYPTION_KEY` (64 hex, optional+warn). .env.example with gen cmd.
- email-queue.service: encryptField on create/update password→passwordEnc.
- inbound.service:57: `pass: decryptField(queue.passwordEnc, key)`.
- scripts/encrypt-queues.ts one-off (idempotent via v1: check).

## D [P1] Staff notifications (no notify-on-assign; prod swnotificationrules has assignment rule)

- notification.service.ts: notifyOnAssign(ticketId,staffId) emails assignee (template notify_staff_assigned); notifyWatchersOnUserReply(ticketId) emails enabled watchers (notify_staff_user_replied).
- TicketsService.assign → notifyOnAssign; reply USER path → notifyWatchersOnUserReply.
- seed 2 templates. workflow.executor: add `notify_staff` action (P2). NotificationRule model = P2 stub (TICKET_ASSIGNED/REPLIED/STATUS_CHANGED/CREATED).

## Tests

mail.service (cc/bcc), tickets (recipient upsert + assign-notify), inbound.service (evaluateCriteria ALL/ANY/regex, applyParserRules skip/route/stop, processMessage discard), parser-rules.service CRUD, field-encrypt.util (roundtrip, tamper throws, legacy passthrough, wrong key), notification.service.

## Priority

P0: IMAP decrypt (1 file+util), CC/BCC schema+send, parser 'ignore' action (junk-ticket prevention). P1: parser route/priority/assign + admin CRUD, assign/watcher notify, CC/BCC admin endpoint. P2: NotificationRule engine.
