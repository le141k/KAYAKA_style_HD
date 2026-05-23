# GOAL — Kayako data migration + email-path (autonomous)

Run: `/goal docs/GOAL_MIGRATION.md`. Migrate the Kayako Classic dump into our portal and make the
email path correct. Built from a 5-agent analysis of the dump (`../kayako_db_export/`) + our schema.
**Execute batches IN ORDER. Self-gate after every batch — never commit red.**

## 🏢 Domain model — how 23 Telecom actually works (READ THIS FIRST)

23 Telecom is an **SMS/voice routing broker/operator** — the helpdesk operator, the hub in the middle.
**All email flows TO 23 Telecom** (queues `noc@` = Customer Issue, `rates@` = Rate Notification,
`rs@` = Vendor Issue, all `@23telecom.co.uk` on Gmail/IMAP). A ticket is one issue that 23T staff
resolve by **MATCHING a customer's request with a supplier (carrier) and communicating with BOTH sides
inside the same ticket**:

- **Customer** reports a problem (e.g. SMS not delivering to a country/operator, or a rate request).
- 23T staff **match it to a supplier/carrier** (Sinch, Lleida, Broadnet, …) that has a route.
- Staff email the **vendor** to fix/adjust the route (macros in category **"to vendor"**), then email the
  **customer** to retest (macros in category **"to customer"** — e.g. _"our provider has made route
  adjustments, kindly retest and share your results"_).
- So every real ticket has a **client side AND a supplier side**; posts are addressed to one or the other
  (`swticketposts.email`/`emailto`, `isthirdparty=1` = the vendor/supplier post), and the **macros are
  deliberately split customer-vs-vendor** for this dual communication. Ticket **type** = `Customer Issue`
  / `Vendor Issue` / `Rate Notification`.
- Orgs split three ways: **23 Telecom = INTERNAL**, customers = **CLIENT**, carriers = **SUPPLIER**.
  > Implication: the matched **client↔supplier pair is the core record**, not an afterthought. Migrated and
  > seeded tickets MUST show both parties + the two-sided email thread, not just a single requester.

## ⚠️ Data reality (read first)

- The dump we have is **SAMPLES ONLY**: `../kayako_db_export/samples.sql` = 96 INSERTs (a sample), `schema.sql` = DDL, `tables_inventory.csv` = row counts. The **full rows are NOT here**: only 3 of 9 orgs, a handful of users, partial macros, 5 of 8 statuses are present.
- **To migrate ALL clients/suppliers + all 63 macros + real tickets, we need the full `mysqldump`** of: `swusers, swuseremails, swuserorganizations, swuserorganizationlinks, swusernotes(+data), swtickets, swticketposts, swticketnotes, swticketrecipients, swticketemails, swticketstatus, swticketpriorities, swtickettypes, swmacrocategories, swmacroreplies(+data), swemailqueues, swparserrules(+criteria+actions), swsignatures, swqueuesignatures`.
- **Build the importer to consume a full dump**; with only `samples.sql` it imports the sampled subset and logs what's missing. **First batch must check whether a full dump exists** (ask/look for `*.sql` with full INSERTs) and proceed accordingly. Do NOT fabricate client/supplier rows that aren't in the data — except the synthetic demo tickets in Batch M3 (explicitly allowed).

## Operating rules (EVERY batch)

1. One batch at a time; a test per change. **Self-gate:** `make reset && make up && make verify` green. Never commit red.
2. Importer is idempotent & re-runnable (upsert by a stored `kayakoId`); keep an `oldId→newId` map per table; resolve FKs in dependency order.
3. Keep the DEV stack working (demo seed). Migration runs ON TOP of seeded reference data — look up status/priority/type/department by title, not by Kayako id.
4. Commit per batch + push; tick done here.
5. STOP when all batches done AND the Definition of Done is green; run `make verify-full`, post a summary.

---

## ☐ Batch M0 — Schema + importer scaffolding

- [ ] Prisma additions + migration: `Organization.orgType` enum `CLIENT|SUPPLIER|INTERNAL` (default CLIENT); **`Ticket.clientOrgId Int?` + `Ticket.supplierOrgId Int?` (FKs → Organization)** to make the matched client↔supplier pair a first-class, queryable record (the core of the 23T model — see Domain model). `Macro.subject String @default("")`; `Macro.isHtml Boolean @default(false)`. (TicketRecipient CC/BCC, EmailQueue, EmailParserRule already exist — no change.) Add a nullable `kayakoId Int? @unique` to Organization, User, Ticket, Macro (for idempotent re-import + FK resolution). _(Fallback if you must avoid schema change: encode supplier as a `TicketRecipient` CC + `isThirdParty` posts — but the explicit FK pair is strongly preferred.)_
- [ ] `apps/api/scripts/import-kayako.ts` (tsx, mirrors seed pattern): a MySQL-INSERT parser (table + columns + rows), in-memory id maps, `prisma.$transaction` inserts in order: Departments→StaffGroup→Staff→Organization→User→UserEmail→Status/Priority/Type→EmailQueue→Macro… Convert Kayako `dateline` (unix) → `DateTime`. Run: `tsx scripts/import-kayako.ts <dump.sql>` against dev DB after `npm run seed`.
- [ ] Detect full-dump vs samples; log counts imported vs `tables_inventory.csv` expectations.
- **Acceptance:** migration applies; importer runs on `samples.sql` without error; `make verify` green.

## ☐ Batch M1 — Clients & suppliers (Task 1)

- [ ] Import `swuserorganizations`→Organization (name, address.\*, phone, website, dateline→createdAt). **Classify orgType** via a curated list in the script: `23 Telecom`→INTERNAL; known carriers (`Lleida`, `Broadnet`, `Sinch`, `NRS Gateway`, …)→SUPPLIER; rest→CLIENT. (No flag exists in Kayako — the `to customer`/`to vendor` macro categories confirm the concept. Print the full 9-org list with chosen orgType for human confirmation.)
- [ ] Import `swusers`→User (fullName, phone, isEnabled, isValidated, organizationId via `swusers.userorganizationid` + `swuserorganizationlinks` for multi-org). **Do NOT migrate passwords** (legacy SHA1) — users reset on first login. `swuseremails`→UserEmail (multi-email; verify `isPrimary` — sampled rows are all 0, pick first if none primary). `swusernotes(+data)`→ user notes.
- **Acceptance:** all orgs+users+emails from the dump imported, counts match `tables_inventory.csv` (or the sampled subset, logged); each Organization has a sensible orgType; re-running the importer changes nothing (idempotent). `make verify` green.

## ☐ Batch M2 — Email path: verify & fix (Task 2)

Fix our mail flow (gaps found vs Kayako), each with a test + MailHog live-check:

- [ ] **Outbound threading headers** — `mail.service.ts` `sendMail()` never sets `In-Reply-To`/`References` → customer MUAs don't thread. Pass the ticket's last-post `messageId` and set the headers on staff replies. (apps/api/src/modules/mail/mail.service.ts:~43; tickets.service.ts reply path ~657)
- [ ] **Per-queue autoresponder** — `tickets.service.ts:~234` sends autoresponder on EVERY new ticket; Kayako gates it per-queue (`swemailqueues.ticketautoresponder`, both noc/rates = OFF). Add `sendAutoresponder` to EmailQueue, honor it for `creationMode=EMAIL`.
- [ ] **Queue signature** — `EmailQueue.signature` exists but is never appended to outbound. Append the sending queue's signature (and `Staff.signature`) to staff replies.
- [ ] **Quoted-reply stripping** — inbound stores full quoted history. Implement `stripQuotedReply(body)` using `swbreaklines` patterns (`----- Original Message -----`, `<!-- Break Line -->`, …); seed patterns into config/table. (inbound.service.ts processMessage)
- [ ] **POST_PARSE rules** — `ParserRuleType.POST_PARSE` exists but `inbound.service.ts:applyParserRules()` only queries PRE_PARSE. Evaluate POST_PARSE after ticket create/append.
- [ ] **Catch-all routing** — implement `swcatchallrules` (regex on To: → queue) before parser rules in `pollQueue()`.
- [ ] **Migrate email config:** `swemailqueues`→EmailQueue (4: noc@/rates@/rs@; decrypt password→passwordEnc, map type, departmentId); `swparserrules`+criteria+actions(10/11/10)→EmailParserRule (JSON criteria/actions; ruletype1→PRE_PARSE, matchtype3→ALL, the 3 enabled bounce-ignore rules are critical); `swsignatures`/`swqueuesignatures`; re-author key `swtemplates` (autoresponder, ticket_user_reply) from Smarty `{$x}`→`{{x}}` into EmailTemplate.
- [ ] **Directed reply (customer vs vendor)** — core to the 23T flow: staff must be able to send a ticket reply to the **customer** OR to the matched **vendor/supplier** (not only the requester). Ensure the reply composer can target the supplier (CC/`supplierOrgId` address), mark that post `isThirdParty`, and that the "to customer"/"to vendor" macros land in the right place. (tickets.service.ts reply path + web ticket-detail composer)
- [ ] (optional) ticket forward (`swticketforwards`), spam filter — defer if time-boxed.
- **Acceptance:** inbound IMAP (MailHog) → ticket; reply by mask threads; staff reply carries In-Reply-To + signature; autoresponder only when queue opts in; quoted history stripped; parser/queue rows imported. Tests + `make verify` green.

## ☐ Batch M3 — Emails into all 8 statuses with client↔supplier (Task 3)

- [ ] Confirm the **8 statuses** (5 known: Initial, In Progress, Closed[markResolved], Pending Vendor, Reply Received; 3 only in the full dump) → seed/map to TicketStatus.
- [ ] For EACH of the 8 statuses, create **5–15 tickets** (from the full dump if present, else synthesize) that model the **real 23T broker flow** — every ticket has BOTH a matched client and supplier:
  - **`clientOrgId`** = a CLIENT org + the customer is the requester (`Ticket.userId`/`requesterEmail`); **`supplierOrgId`** = a matched SUPPLIER/carrier org (Sinch, Lleida, Broadnet, …). Also CC the supplier (`TicketRecipient` role CC) so outbound mirrors Kayako.
  - **Two-sided thread** (5–15 `TicketPost`s): customer post(s) (USER) → 23T staff post(s) → **vendor post(s) `isThirdParty=true`** (the carrier) → staff relays back to customer. Use realistic SMS-routing content (delivery issue → route adjusted → retest), `typeId` = Customer Issue / Vendor Issue / Rate Notification, increasing dates.
  - **Status-specific shape:** Initial = customer just wrote in (1–2 posts, no supplier yet); In Progress = staff matched + emailed the vendor; Pending Vendor = last post is the vendor request, awaiting their reply; Reply Received = vendor `isThirdParty` reply just arrived; Closed = full resolved thread (vendor fixed → customer retested → confirmed).
- **Acceptance:** every status has 5–15 tickets; each shows a **matched CLIENT + SUPPLIER** (`clientOrgId`+`supplierOrgId`, CC, ≥1 `isThirdParty` vendor post) AND visible two-sided communication in the staff UI. `make verify` green.

## ☐ Batch M4 — Reply macros (Task 4)

- [ ] `swmacrocategories`(5)→MacroCategory (title, parentId; hierarchy: `sms`→`to customer`/`to vendor`+2). `swmacroreplies`(63)+`swmacroreplydata`(63)→Macro: `title`, `replyText`=`swmacroreplydata.contents`, `subject`, `isHtml`, `isShared` from category `categorytype`, and `actions` JSON from the inline action cols (departmentid/ticketstatusid/priorityid/ownerstaffid/tickettypeid where `≠ -1` → SET_STATUS/SET_PRIORITY/etc.). Map action FKs via the oldId→newId maps.
- **Acceptance:** all macros+categories imported (count vs dump); a migrated macro applies to a ticket in the UI (sets reply text + actions). `make verify` green.

---

## ✅ Definition of Done — STOP when all green

- [ ] Orgs/users/emails imported + classified client/supplier (idempotent re-run).
- [ ] Email-path gaps fixed (threading headers, per-queue autoresponder, signature, quote-strip, POST_PARSE, catch-all) + queues/parser-rules imported; verified live via MailHog.
- [ ] 5–15 tickets in EACH of the 8 statuses, each with a **matched client + supplier** (`clientOrgId`+`supplierOrgId`) and a **two-sided thread** (customer ↔ 23T ↔ vendor `isThirdParty`).
- [ ] All reply macros + categories imported and applicable.
- [ ] `make verify-full` green (gate + e2e); dev loop intact.

## ⛔ OUT OF SCOPE / decisions for the human

- Need the **full mysqldump** to migrate ALL data (samples.sql is a subset) — flag if absent.
- Confirm orgType of the 9 orgs (script prints them) and the 3 unknown status names (from full dump).
- Spam (Bayes), ticket-forward, GeoIP, KB articles, reports — not part of this goal.
