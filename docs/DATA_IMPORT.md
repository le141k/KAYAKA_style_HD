# Kayako data import (real data from the Proxmox backup)

How the product DB was populated with **real 23 Telecom Kayako data** (not synthetic demo).
Source: `vzdump-201-kayako-helpdesk.tar.gz` (Proxmox LXC backup, MySQL 8.0 DB `kayako_fusion`).

## ⚠️ Persistence

The imported rows live in the **Postgres volume**. `make reset` (`docker compose down -v`) **WIPES them.**
To restore after a reset: re-run the two importers below (the `.sql` dumps persist in `kayako_db_export/`,
which is OUTSIDE the repo so `git clean` won't touch it).

## Dumps (in `../kayako_db_export/`, sibling of this repo)

| File                             | Tables                                                                                                                                                                                      | Scope                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `kayako_real_core.sql`           | orgs, org-links, users, emails, user-notes, macros(+cats+data), email queues, parser rules(+criteria+actions), catch-all, departments, statuses, priorities, types, staff, signatures, tags | **FULL**                                                       |
| `kayako_real_sample_tickets.sql` | tickets, posts, tag-links, ticket-notes, tags                                                                                                                                               | **SAMPLE** — 17 client/supplier-linked tickets across statuses |

Both produced with `mysqldump --complete-insert` (the parser keys rows by column name).

## Re-import (after `make reset && make up`)

```bash
cd apps/api
# 1. core: orgs/users/macros/email-config (idempotent upsert by kayakoId)
npx tsx scripts/import-kayako.ts "../../../kayako_db_export/kayako_real_core.sql" \
  --inventory "../../../kayako_db_export/tables_inventory.csv"
# 2. sampled tickets + posts + tags + notes (idempotent by Ticket.kayakoId)
npx tsx scripts/import-kayako-tickets.ts "../../../kayako_db_export/kayako_real_sample_tickets.sql"
```

Result (verified live): 9 orgs (1 INTERNAL / 3 SUPPLIER / 5 CLIENT), 339 users, 340 emails,
63 macros, 10 parser rules; 17 tickets, 32 posts, 15 tags, 9 tag-links, 8 notes.

## Org classification (per the 23T domain model)

`23 Telecom` → INTERNAL · `Lleida` / `Broadnet` / `Sinch(CLX)` → SUPPLIER · everyone else → CLIENT
(driven by `SUPPLIER_NAMES` in `src/migration/kayako-parser.ts`).

## Ticket field mapping (Kayako → product, by denormalized title)

- **status:** Initial/Reply Received → Open · Pending Vendor/Customer/Forwarded → Pending · In Progress → In Progress · Escalated → In Progress(+isEscalated) · Closed → Closed
- **priority:** Low/Normal/High/Urgent (1:1) · **type:** Customer Issue → Issue · Vendor Issue → Incident · Rate Notification → Question · **dept:** General → product default
- **posts:** `staffid>0` → STAFF else USER; `isprivate=1` posts are SKIPPED (the product TicketPost is the public thread).

## How the dumps were regenerated from the archive (one-off, reference)

```bash
# extract just the MySQL datadir from the LXC backup
tar -xzf vzdump-201-kayako-helpdesk.tar.gz -C /tmp/recover ./var/lib/mysql
# load it into a matching-version engine (8.0.x pre-8.0.30 redo-log format), no password
docker run -d --name kayako-recover -v <datadir>:/var/lib/mysql mysql:8.0.29 --skip-grant-tables --skip-log-bin
# dump the needed tables via the local socket (see kayako_db_export/*.sql for the exact table lists)
docker exec kayako-recover mysqldump --no-tablespaces --skip-lock-tables --no-create-info \
  --complete-insert --default-character-set=utf8mb4 kayako_fusion <tables...>
```
