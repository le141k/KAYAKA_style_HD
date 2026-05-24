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

## ✅ Batch M1 — Clients & suppliers (DONE)

- [x] `swuserorganizations`→Organization (done in M0): name/address/phone/website, dateline→createdAt, orgType via `classifyOrg` (23 Telecom→INTERNAL; Lleida/Broadnet/Sinch/NRS/…→SUPPLIER; rest→CLIENT). Prints the org list for confirmation.
- [x] `swusers`→User: fullName, phone, designation, isEnabled, isValidated, timezone, organizationId via `userorganizationid` (fallback to `swuserorganizationlinks`), dateline→createdAt. **Passwords NOT migrated** (passwordHash null → reset on first login). `swuseremails`→UserEmail (`groupUserEmails`: only `linktype=1` user emails; org emails `linktype=2` skipped; first→primary when none flagged; lowercased, upsert by email). `swusernotes(+data)`→`User.customFields.notes` (no UserNote model; 1 note in dump, targets a user absent from the sample). +2 parser tests (`groupUserEmails`).
- **Acceptance:** orgs+users+emails imported from the (sampled) dump; counts logged vs inventory; orgType sensible; **idempotent re-run verified** (no unique-violation, counts stable). **Live: 3 users, 2 emails (user-4 email is an org email → skipped), 0 notes (owner absent); users linked to mapped org.** `make verify` GREEN 9/9.
- **⚠️ Sampled:** only 3/339 users, 3/350 emails, 3/9 orgs present — full mysqldump needed for the rest (importer ready to consume it).

## ☐ Batch M2 — Email path: verify & fix (Task 2)

Fix our mail flow (gaps found vs Kayako), each with a test + MailHog live-check:

- [x] **Outbound threading headers** — `SendMailOptions`/`send()`/`sendTemplate()` now accept `inReplyTo`/`references`; the staff-reply path threads off the most recent prior post's `messageId`. **Live (MailHog): reply carried `In-Reply-To: <customer-msg-1@mail>` + `References`.** +2 mail tests.
- [x] **Per-queue autoresponder** — added `EmailQueue.sendAutoresponder` (migration `20260531000000`); `createTicket` now suppresses the autoresponder for `creationMode=EMAIL` unless the ticket's department queue opts in (web/staff/API unchanged).
- [x] **Queue + staff signature** — staff replies append `Staff.signature` + the department `EmailQueue.signature` below a `--` separator. **Live (MailHog): both signatures present in the reply body.**
- [x] **Quoted-reply stripping** — `stripQuotedReply()` (swbreaklines markers `----- Original Message -----`, `<!-- Break Line -->`, + `On … wrote:`/`From:` headers) applied to the inbound text body in `processMessage`. +6 util tests.
- [ ] **POST_PARSE rules** — DEFERRED (refinement): `applyParserRules` still only evaluates PRE_PARSE; POST_PARSE after create/append not yet wired.
- [ ] **Catch-all routing** — DEFERRED: needs `swcatchallrules` data (full dump); current routing is per-queue department.
- [x] **Migrate email config:** `swemailqueues`→EmailQueue (type map, host/port/username, dept=default; **password NOT migrated — Kayako's key is unavailable, queues import DISABLED with empty `passwordEnc`**, `ticketautoresponder`→`sendAutoresponder`); `swparserrules`+criteria+actions→EmailParserRule (JSON criteria/actions; ruletype→PRE/POST_PARSE, matchtype3→ALL, ruleop→op; the 3 bounce-ignore loop-prevention rules import faithfully). **Live: 3 queues + 3 parser rules imported, criteria/actions JSON matches the inbound evaluator.** +2 mapper tests. (`swsignatures`/`swqueuesignatures` + Smarty→`{{x}}` `swtemplates` re-author = DEFERRED.)
- [ ] **Auto-ingest (client → ticket)** — inbound `processMessage` already creates a CLIENT ticket (`creationMode=EMAIL`) for unthreaded mail + threads replies by RFC headers / mask. **Note:** MailHog is an SMTP sink (no IMAP), so a true IMAP poll can't be exercised against it; the create/thread logic is covered by the existing inbound spec + the live reply-threading check. Full IMAP live-ingest = DEFERRED (needs an IMAP test server).
- [x] **Spawn linked supplier ticket** (DONE, commit `fdd2dae`) — `POST /tickets/:id/spawn-supplier` (TICKET_CREATE) creates a NEW supplier ticket (requester = carrier, type = Vendor Issue when present, inherits department) auto-linked to the client ticket (`linkType=supplier`); UI "Contact supplier" action in `LinkedTicketsPanel` (i18n ru/en/uk). **Live: client TT-1 → supplier TT-6, linked both ways.** +1 test. (Vendor-Issue type is best-effort until `swtickettypes`/M3 seed it.)
- [ ] (optional) ticket forward (`swticketforwards`), spam filter — defer if time-boxed.
- **Acceptance:** inbound IMAP (MailHog) → ticket; reply by mask threads; staff reply carries In-Reply-To + signature; autoresponder only when queue opts in; quoted history stripped; parser/queue rows imported. Tests + `make verify` green.

## ✅ Batch M3 — Emails into all 8 statuses with client↔supplier (DONE)

- [x] **8 statuses** ensured by the generator (5 seeded — Open/Pending/In Progress/Resolved/Closed — + 3 23T-specific: **Initial, Pending Vendor, Reply Received**). The 3 _Kayako_ unknown status names still need the full dump; this demo uses the documented 23T set.
- [x] `scripts/seed-demo-pairs.ts` (run after `npm run seed`): for EACH of the 8 statuses creates **5–15 CLIENT tickets** (type **Customer Issue**, requester = a customer org, thread = customer ↔ 23T only), each with a **LINKED SUPPLIER ticket** (type **Vendor Issue**, requester = a carrier Sinch/Lleida/Broadnet, thread = 23T ↔ vendor with `isThirdParty`), joined by a `TicketLink` (linkType=`supplier`). Realistic SMS-routing content + increasing dates. Status-specific shaping (Initial = just the customer; past-Initial = 23T acknowledged; Reply Received/Resolved/Closed = vendor replied / fix confirmed). Idempotent via a `customFields.demoPair` marker (re-run wipes + regenerates).
- **Acceptance:** **Live: 75 client + 75 linked supplier tickets, every status with 5–15 clients; pair TT‑268↔TT‑269 verified — client side = USER+STAFF (no third-party), supplier side = type Vendor Issue with STAFF + carrier `isThirdParty=true`; visible/openable in the Linked-tickets panel.** Idempotent re-run (removed 150 → regenerated 75 pairs). `make verify` GREEN 9/9.

## ✅ Batch M4 — Reply macros (DONE)

- [x] `swmacrocategories`→MacroCategory (title + parent hierarchy, parents-first; upsert by title). `swmacroreplies`+`swmacroreplydata`→Macro (upsert by `kayakoId`): `title`/`subject`, `replyText`=`swmacroreplydata.contents`, `isHtml=false`, `isShared` from category `categorytype` (≠2). `actions` JSON built from the inline FK cols (`ticketstatusid`→set_status, `priorityid`→set_priority, `departmentid`→change_department) resolved via `buildReferenceMaps` (kayakoId→ourId matched by TITLE on status/priority/type/dept); unmappable FKs (e.g. a ticket type absent from our seed) are skipped. `ownerstaffid`/`tickettypeid` have no apply path → skipped.
- **Acceptance:** **Live: 3 categories (`sms`→`to customer`/`to vendor`) + 3 macros imported; action `set_status` correctly mapped (Kayako 'Closed' id 3 → our id 5); a migrated macro applied to a ticket via the UI/API set the status to Closed AND posted the reply text.** Idempotent re-run (counts stable). `make verify` GREEN 9/9.
- **⚠️ Sampled:** 3/63 macros, 3/5 categories present — full mysqldump needed for all 63 (importer ready: it consumes whatever the dump contains and maps action FKs by title).

---

## ✅ Definition of Done — STOP when all green

- [x] Orgs/users/emails imported + classified client/supplier/internal (idempotent re-run). _(Sampled subset; full dump pending.)_
- [x] **Ticket-linking feature built** (API + UI) — link/unlink/list; "Linked tickets" panel shows the client↔supplier counterpart.
- [x] **"spawn linked supplier ticket"** action works (live). _Auto-ingest: inbound create/thread logic in place + reply-threading live-verified; full IMAP poll not exercisable against MailHog (SMTP-only) — documented in M2._
- [x] Email-path gaps fixed (threading headers, per-queue autoresponder, signature, quote-strip) + queues/parser-rules imported; threading + signature verified live via MailHog. _(POST_PARSE / catch-all deferred — see M2.)_
- [x] 5–15 **client tickets** in EACH of the 8 statuses, **each linked to a supplier ticket** (client side = customer↔23T, supplier side = 23T↔vendor `isThirdParty`). _(Run `tsx scripts/seed-demo-pairs.ts` after seed.)_
- [x] All reply macros + the "to customer"/"to vendor" categories imported and applicable (sampled subset; a migrated macro applied live).
- [ ] `make verify-full` green (gate + e2e); dev loop intact. _(Per-batch `make verify` GREEN throughout; final verify-full pending.)_

## ⛔ OUT OF SCOPE / decisions for the human

- Need the **full mysqldump** to migrate ALL data (samples.sql is a subset) — flag if absent.
- Confirm orgType of the 9 orgs (script prints them) and the 3 unknown status names (from full dump).
- Spam (Bayes), ticket-forward, GeoIP, KB articles, reports — not part of this goal.
