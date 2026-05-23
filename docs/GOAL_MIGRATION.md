# GOAL — Kayako data migration + email-path (autonomous)

Run: `/goal docs/GOAL_MIGRATION.md`. Migrate the Kayako Classic dump into our portal and make the
email path correct. Built from a 5-agent analysis of the dump (`../kayako_db_export/`) + our schema.
**Execute batches IN ORDER. Self-gate after every batch — never commit red.**

## 🏢 Domain model — how 23 Telecom actually works (READ THIS FIRST)

23 Telecom is an **SMS/voice routing broker/operator** — the helpdesk operator, the hub in the middle.
**All email flows TO 23 Telecom** (queues `noc@` = Customer Issue, `rates@` = Rate Notification,
`rs@` = Vendor Issue, all `@23telecom.co.uk` on Gmail/IMAP). The workflow is **two LINKED tickets**, not one:

1. **Auto-ingest:** a **customer emails `noc@23telecom.co.uk`** → the IMAP poller auto-pulls it → a
   **CLIENT ticket is created automatically** (creationMode = EMAIL, type = Customer Issue).
2. **NOC works the client ticket:** investigates, replies to the customer ("we're on it" / retest) using
   the **"to customer"** macros.
3. **In parallel, NOC contacts the matched supplier/carrier** (Sinch, Lleida, Broadnet, …) → this spawns a
   **NEW SUPPLIER ticket, LINKED to the client ticket** (`TicketLink`), where staff use the **"to vendor"**
   macros (fix/adjust the route).
4. Vendor replies on the supplier ticket → NOC relays the result back on the client ticket → customer
   retests → resolved. The **link** keeps the customer-side and vendor-side conversations tied together.

- Orgs split three ways: **23 Telecom = INTERNAL**, customers = **CLIENT**, carriers = **SUPPLIER**
  (confirmed: 23 Telecom=internal; Lleida/Broadnet/Sinch=suppliers; the rest=clients).
  > Implication: the unit of work is a **linked pair of tickets** (client ticket ↔ supplier ticket), each with
  > its own one-sided thread, joined by a `TicketLink`. NOT a single ticket with mixed posts. Our schema HAS
  > a `TicketLink` model but **no API/UI yet** — the linking feature must be built (see M0/M2).

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

## ✅ Batch M0 — Schema + importer scaffolding (DONE)

- [x] Prisma + migration `20260530000000_kayako_migration_scaffold`: `OrgType` enum `CLIENT|SUPPLIER|INTERNAL` + `Organization.orgType` (default CLIENT); `Macro.subject`/`Macro.isHtml`; nullable `kayakoId Int? @unique` on Organization/User/Ticket/Macro. (Updated 6 ticket test-factories + `SAFE_USER_SELECT` for the new required field.)
- [x] **Ticket-linking FEATURE built** — `POST /tickets/:id/links`, `GET /tickets/:id/links` (both directions, inverse label for inbound), `DELETE /tickets/:id/links/:linkId` (RBAC TICKET_EDIT; self-link + bi-directional-dup guarded). UI: `LinkedTicketsPanel` in the ticket-detail sidebar (i18n ru/en/uk), shows the linked counterpart + opens it + link/unlink. **Live: link 1→2 supplier; ticket-2 side reads `client`; dup 400; self-link 400.** +6 service tests.
- [x] `scripts/import-kayako.ts` + `src/migration/kayako-parser.ts`: a mysqldump INSERT parser (quote/escape aware, multi-statement), `IdMap` (oldId→newId per table), `datelineToDate`, `classifyOrg`. Dependency-ordered runner; Organization import (upsert by `kayakoId`, orgType classification, prints the org list). +7 parser tests.
- [x] Full-dump vs samples detection: logs parsed-vs-inventory counts per table; prints a SAMPLED-DUMP warning. **Live on samples.sql: orgs 3/9, users 3/339, macros 3/63 → flagged; idempotent re-run; DB has 1 INTERNAL + 2 SUPPLIER.**
- **Acceptance:** migration applies; importer runs on `samples.sql` without error + idempotent; linking API live-verified; `make verify` GREEN 9/9. ✅
- **⚠️ DATA REALITY:** only `samples.sql` exists (3-row samples per table) — **the full mysqldump is absent.** Org list shows only **3 of 9** (23 Telecom=INTERNAL, Lleida + Broadnet=SUPPLIER); the other 6 orgs, all real users, the full 63 macros, and 3 of 8 status names need the full dump.

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
- [ ] **Auto-ingest (client → ticket)** — verify end-to-end that a mail arriving at a queue (`noc@`) is auto-pulled by the IMAP poller and **auto-creates a CLIENT ticket** (creationMode=EMAIL, correct type/queue). `inbound.service.ts` exists — confirm it works against a test IMAP/MailHog-equivalent and the noc@/rates@/rs@ queues route to the right type.
- [ ] **Spawn linked supplier ticket** — the core NOC action: from a client ticket, "Написать поставщику / Contact supplier" creates a **NEW supplier ticket** (requester = the matched carrier, type = Vendor Issue, prefilled) **auto-linked** to the client ticket via `TicketLink` (linkType=`supplier`). Staff then use the **"to vendor"** macros there; the **"to customer"** macros stay on the client ticket. (new endpoint + ticket-detail button)
- [ ] (optional) ticket forward (`swticketforwards`), spam filter — defer if time-boxed.
- **Acceptance:** inbound IMAP (MailHog) → ticket; reply by mask threads; staff reply carries In-Reply-To + signature; autoresponder only when queue opts in; quoted history stripped; parser/queue rows imported. Tests + `make verify` green.

## ☐ Batch M3 — Emails into all 8 statuses with client↔supplier (Task 3)

- [ ] Confirm the **8 statuses** (5 known: Initial, In Progress, Closed[markResolved], Pending Vendor, Reply Received; 3 only in the full dump) → seed/map to TicketStatus.
- [ ] For EACH of the 8 statuses, create **5–15 CLIENT tickets**, and for each one a **LINKED SUPPLIER ticket** (the real 23T model = a linked pair, see Domain model):
  - **Client ticket:** requester = a customer (CLIENT org, e.g. via `noc@`, type Customer Issue), thread = customer ↔ 23T posts only (no vendor posts here). Status = the target status.
  - **Supplier ticket:** requester/recipient = the matched carrier (SUPPLIER org: Sinch/Lleida/Broadnet…), type Vendor Issue, thread = 23T ↔ vendor posts (`isThirdParty` for the carrier). Created via the M2 "spawn linked supplier ticket" action.
  - **Link them** with a `TicketLink` (linkType=`supplier`/`client`). Realistic SMS-routing content (delivery issue → ask vendor to fix route → vendor adjusts → customer retests). Increasing dates.
  - **Status-specific shape (on the CLIENT ticket):** Initial = customer just wrote in, no supplier ticket yet; In Progress = supplier ticket spawned + linked; Pending Vendor = supplier ticket awaiting vendor reply; Reply Received = vendor replied on the supplier ticket; Closed = both resolved (vendor fixed → customer confirmed).
- **Acceptance:** every status has 5–15 client tickets; each is **linked to a supplier ticket** (visible in the "Linked tickets" panel, openable), client side shows customer↔23T, supplier side shows 23T↔vendor (`isThirdParty`); both reachable in the staff UI. `make verify` green.

## ☐ Batch M4 — Reply macros (Task 4)

- [ ] `swmacrocategories`(5)→MacroCategory (title, parentId; hierarchy: `sms`→`to customer`/`to vendor`+2). `swmacroreplies`(63)+`swmacroreplydata`(63)→Macro: `title`, `replyText`=`swmacroreplydata.contents`, `subject`, `isHtml`, `isShared` from category `categorytype`, and `actions` JSON from the inline action cols (departmentid/ticketstatusid/priorityid/ownerstaffid/tickettypeid where `≠ -1` → SET_STATUS/SET_PRIORITY/etc.). Map action FKs via the oldId→newId maps.
- **Acceptance:** all macros+categories imported (count vs dump); a migrated macro applies to a ticket in the UI (sets reply text + actions). `make verify` green.

---

## ✅ Definition of Done — STOP when all green

- [ ] Orgs/users/emails imported + classified client/supplier/internal (idempotent re-run).
- [ ] **Ticket-linking feature built** (API + UI) — link/unlink/list; "Linked tickets" panel shows the client↔supplier counterpart.
- [ ] **Auto-ingest verified** (mail → noc@ → auto client ticket) + **"spawn linked supplier ticket"** action works.
- [ ] Email-path gaps fixed (threading headers, per-queue autoresponder, signature, quote-strip, POST_PARSE, catch-all) + queues/parser-rules imported; verified live via MailHog.
- [ ] 5–15 **client tickets** in EACH of the 8 statuses, **each linked to a supplier ticket** (client side = customer↔23T, supplier side = 23T↔vendor `isThirdParty`).
- [ ] All reply macros + the "to customer"/"to vendor" categories imported and applicable.
- [ ] `make verify-full` green (gate + e2e); dev loop intact.

## ⛔ OUT OF SCOPE / decisions for the human

- Need the **full mysqldump** to migrate ALL data (samples.sql is a subset) — flag if absent.
- Confirm orgType of the 9 orgs (script prints them) and the 3 unknown status names (from full dump).
- Spam (Bayes), ticket-forward, GeoIP, KB articles, reports — not part of this goal.
