# Database model — 23 Telecom Help Desk

> **Living doc** — derived from `apps/api/prisma/schema.prisma` (the authoritative source).
> Must be updated whenever the schema changes. Cross-references:
> [ADR-0002](adr/0002-custom-fields-jsonb.md) (custom fields as JSONB),
> [ADR-0003](adr/0003-attachments-storage.md) (attachments by storage key).
> _Last regenerated: 2026-05-22._

---

## Overview

**Engine:** PostgreSQL 16, accessed via **Prisma ORM** (client: `prisma-client-js`).  
**Connection:** `DATABASE_URL` environment variable (`TELECOM_HD_*` convention; default DB name `telecom_hd`).

### Modernizations vs. the legacy Kayako `kayako_fusion` schema

| Concern               | Legacy Kayako                                 | This schema                                             |
| --------------------- | --------------------------------------------- | ------------------------------------------------------- |
| Referential integrity | No foreign keys; orphaned rows common         | Real FK constraints on every relation                   |
| Timestamps            | Unix-int columns (`dateline`, `lastactivity`) | `DateTime` columns with Prisma auto-management          |
| Custom field values   | EAV table `swcustomfieldvalues`               | JSONB `customFields` column on owning entity (ADR-0002) |
| Attachments           | Chunked BLOBs in `swattachmentchunks`         | `storageKey` pointer to object store / disk (ADR-0003)  |
| Denormalized mirrors  | `*title` columns on tickets, posts            | Dropped; joined live from reference tables              |
| Staff permissions     | EAV `swstaffpermissions` (~250 keys)          | Typed `String[]` on `StaffGroup.permissions`            |
| Settings              | EAV `swsettings`                              | Small `Setting(section, key, value Json)` table         |

---

## Entity groups

### 1. Staff & RBAC

| Model            | Key columns                                                                                                                                                                                                                        | Relations                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **StaffGroup**   | `id`, `title`, `isAdmin Bool`, `permissions String[]`                                                                                                                                                                              | has many `Staff`                                                                                                                                                              |
| **Staff**        | `id`, `email` (unique), `username` (unique), `firstName`, `lastName`, `passwordHash` (argon2id), `designation`, `signature`, `mobileNumber`, `timezone`, `isEnabled`, `authVersion Int` (default 0), `staffGroupId`, `lastLoginAt` | belongs to `StaffGroup`; has many `DepartmentStaff`, `ownedTickets` (Ticket via "TicketOwner"), `TicketPost`, `TicketNote`, `TicketAuditLog`, `RefreshToken`, `TicketWatcher` |
| **RefreshToken** | `id` (UUID), `staffId`, `tokenHash` (unique), `expiresAt`, `revokedAt?`, `createdAt`                                                                                                                                               | belongs to `Staff` (cascade delete)                                                                                                                                           |

`StaffGroup.permissions` is an array of permission-key strings defined in `apps/api/src/auth/permissions.ts`. Admin groups carry `ALL_PERMISSIONS`; agent groups carry a curated `ROLE_PRESETS.agent` subset.

---

### 2. Customers & Organizations

| Model            | Key columns                                                                                                                                                                                            | Relations                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| **UserGroup**    | `id`, `title`, `type UserGroupType`, `isMaster Bool`                                                                                                                                                   | has many `User`                                                                             |
| **Organization** | `id`, `name`, `address`, `city`, `state`, `postalCode`, `country`, `phone`, `website`, `slaPlanId?`, `customFields Json`                                                                               | optional FK to `SlaPlan`; has many `User`                                                   |
| **User**         | `id`, `fullName`, `phone`, `designation`, `passwordHash?` (nullable — email-only users), `isEnabled`, `isValidated`, `timezone`, `userGroupId?`, `organizationId?`, `geoip Json?`, `customFields Json` | optional FK to `UserGroup` and `Organization`; has many `UserEmail`, `Ticket`, `TicketPost` |
| **UserEmail**    | `id`, `userId`, `email` (unique), `isPrimary Bool`                                                                                                                                                     | belongs to `User` (cascade delete)                                                          |

`User.customFields` and `Organization.customFields` store custom-field values as `{ [fieldKey]: value }` JSONB objects, where keys correspond to `CustomField.fieldKey` records in the matching `CustomFieldGroup` (scope `USER` or `ORGANIZATION`).

`User.geoip` is a freeform JSONB blob populated from inbound-email GeoIP lookup (optional).

---

### 3. Departments

| Model               | Key columns                                                                                                             | Relations                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Department**      | `id`, `title`, `type DepartmentType`, `app String` (default `"tickets"`), `isDefault Bool`, `displayOrder`, `parentId?` | self-relation "DepartmentTree" (parent/children); has many `Ticket`, `DepartmentStaff`, `EmailQueue` |
| **DepartmentStaff** | composite PK `(departmentId, staffId)`                                                                                  | belongs to `Department` (cascade) and `Staff` (cascade) — join table                                 |

Departments support one level of nesting via `parentId`. The `type` controls public visibility (see `DepartmentType` enum).

---

### 4. Tickets

#### Reference data

| Model              | Key columns                                                                                                                      | Relations         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **TicketStatus**   | `id`, `title`, `displayOrder`, `markAsResolved Bool`, `color`, `bgColor`, `displayIcon`, `triggersSurvey Bool`, `isDefault Bool` | has many `Ticket` |
| **TicketPriority** | `id`, `title`, `displayOrder`, `color`, `bgColor`                                                                                | has many `Ticket` |
| **TicketType**     | `id`, `title`, `displayOrder`, `displayIcon`                                                                                     | has many `Ticket` |

#### Core ticket entities

| Model              | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Relations / notes                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ticket**         | `id`; `mask` (unique, e.g. `TT-000123`); `subject`; `departmentId`; `statusId`; `priorityId`; `typeId?`; `userId?`; `requesterName`; `requesterEmail`; `ownerStaffId?`; `slaPlanId?`; `dueAt?`; `resolutionDueAt?`; `firstResponseAt?`; `resolvedAt?`; `reopenedAt?`; `creationMode CreationMode`; `creator ActorType`; `flagType FlagType`; `totalReplies Int`; `hasAttachments Bool`; `hasNotes Bool`; `isResolved Bool`; `isEscalated Bool`; `escalationLevel Int`; `wasReopened Bool`; `isPhoneCall Bool`; `ipAddress`; `messageId?`; `mergedIntoId?`; `customFields Json`; `lastReplyAt?`; `lastActivityAt`; `createdAt`; `updatedAt` | Belongs to `Department`, `TicketStatus`, `TicketPriority`, optional `TicketType`, optional `User`, optional owner `Staff`, optional `SlaPlan`; self-relation "TicketMerge" (`mergedInto`/`mergedFrom`); has many `TicketPost`, `TicketNote`, `Attachment`, `TicketWatcher`, `TicketTag`, `TicketAuditLog`, `TicketLink` (as source and target), optional one `AlarisEvent` |
| **TicketPost**     | `id`, `ticketId`, `authorType ActorType`, `staffId?`, `userId?`, `fullName`, `email`, `subject`, `contents` (HTML or plaintext), `isHtml Bool`, `isEmailed Bool`, `isThirdParty Bool`, `creationMode CreationMode`, `messageId?` (RFC Message-ID), `ipAddress`, `editedAt?`, `editedByStaffId?`, `createdAt`                                                                                                                                                                                                                                                                                                                               | Belongs to `Ticket` (cascade delete); optional `Staff`/`User`; has many `Attachment`                                                                                                                                                                                                                                                                                       |
| **TicketNote**     | `id`, `ticketId`, `staffId?`, `contents`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Belongs to `Ticket` (cascade delete); optional `Staff` — internal notes only                                                                                                                                                                                                                                                                                               |
| **Attachment**     | `id`, `ticketId?`, `postId?`, `fileName`, `mimeType`, `size Int`, `sha1`, `storageKey` (path/key in object store), `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Optional FK to `Ticket` and `TicketPost` (both cascade delete)                                                                                                                                                                                                                                                                                                             |
| **TicketWatcher**  | composite PK `(ticketId, staffId)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Belongs to `Ticket` (cascade) and `Staff` (cascade) — join table                                                                                                                                                                                                                                                                                                           |
| **TicketTag**      | `id`, `name` (unique)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | many-to-many with `Ticket` (implicit join table)                                                                                                                                                                                                                                                                                                                           |
| **TicketAuditLog** | `id`, `ticketId`, `staffId?`, `actorType ActorType`, `action` (e.g. `STATUS_CHANGE`, `ASSIGN`, `REPLY`, `MERGE`), `field?`, `oldValue?`, `newValue?`, `createdAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Belongs to `Ticket` (cascade delete); optional `Staff`                                                                                                                                                                                                                                                                                                                     |
| **TicketLink**     | `id`, `sourceId`, `targetId`, `linkType` (default `"related"`); unique `(sourceId, targetId)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Belongs to `Ticket` as source and target (both cascade delete)                                                                                                                                                                                                                                                                                                             |

`Ticket.customFields` stores custom field values for fields in `CustomFieldGroup` with `scope = TICKET`.  
`Ticket.mask` is the human-readable ID (format `TT-NNNNNN`) generated post-insert and stored as a unique string.  
Denormalized counters (`totalReplies`, `hasAttachments`, `hasNotes`) are updated by service-layer logic after mutations.

---

### 5. SLA & Escalation

| Model              | Key columns                                                                                                                                                            | Relations                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **SlaSchedule**    | `id`, `title`, `workHours Json` (weekly hours object, e.g. `{ mon: [["09:00","18:00"]] }`), `createdAt`                                                                | has many `SlaHoliday`, `SlaPlan`                                                  |
| **SlaHoliday**     | `id`, `scheduleId`, `title`, `date DateTime`                                                                                                                           | Belongs to `SlaSchedule` (cascade delete)                                         |
| **SlaPlan**        | `id`, `title`, `isEnabled Bool`, `criteria Json` (auto-apply rule set), `firstResponseSeconds Int?`, `resolutionSeconds Int?`, `scheduleId?`, `createdAt`, `updatedAt` | Optional FK to `SlaSchedule`; has many `EscalationRule`, `Ticket`, `Organization` |
| **EscalationRule** | `id`, `slaPlanId`, `name`, `targetType SlaTargetType`, `thresholdSeconds Int`, `actions Json` (list of actions to run on breach), `isEnabled Bool`                     | Belongs to `SlaPlan` (cascade delete)                                             |

`SlaSchedule.workHours` is a JSONB object keyed by lowercase weekday (`mon`–`sun`), each value an array of `[start, end]` time-range pairs.  
`SlaPlan.criteria` is a JSONB rule array used to auto-match incoming tickets to the plan.  
`EscalationRule.actions` is a JSONB array of action descriptors (assign, notify, priority change, etc.).

---

### 6. Workflows & Macros

| Model             | Key columns                                                                                                 | Relations                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **MacroCategory** | `id`, `title`, `parentId?`                                                                                  | Self-relation "MacroTree"; has many `Macro` |
| **Macro**         | `id`, `categoryId?`, `title`, `replyText`, `actions Json`, `createdAt`                                      | Optional FK to `MacroCategory`              |
| **Workflow**      | `id`, `title`, `criteria Json`, `actions Json`, `isEnabled Bool`, `sortOrder Int`, `createdAt`, `updatedAt` | —                                           |

`Workflow.criteria` and `Workflow.actions` are JSONB condition/action sets evaluated against ticket events.  
`Macro.actions` is a JSONB array of bulk actions applied when a macro is triggered.

---

### 7. Mail

| Model             | Key columns                                                                                                                                                                                              | Relations                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **EmailQueue**    | `id`, `type EmailQueueType`, `emailAddress`, `host`, `port Int` (default 993), `username`, `passwordEnc` (encrypted at rest), `useTls Bool`, `departmentId?`, `signature`, `isEnabled Bool`, `createdAt` | Optional FK to `Department` |
| **EmailTemplate** | `id`, `key` (e.g. `ticket_user_reply`, `autoresponder`, `sla_breach_internal`), `locale` (default `en`), `subject`, `htmlBody`, `textBody`, `updatedAt`; unique `(key, locale)`                          | —                           |

Templates use `{{placeholder}}` interpolation (mustache-style). Seeded templates cover
`ticket_user_reply` and `autoresponder` in English and Russian, plus `sla_breach_internal`,
`notify_staff_assigned`, `notify_staff_user_replied` and `password_reset` in English.
`password_reset` is additionally provisioned in production by migration
`20260716000000_password_reset_template` (the production seed does not run).

---

### 8. Custom Fields

| Model                | Key columns                                                                                                                                                                                                                                             | Relations                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **CustomFieldGroup** | `id`, `title`, `scope CustomFieldScope`, `displayOrder Int`                                                                                                                                                                                             | has many `CustomField`                         |
| **CustomField**      | `id`, `groupId`, `fieldKey` (stable key used inside the JSONB), `title`, `type CustomFieldType`, `isRequired Bool`, `isEncrypted Bool`, `options Json` (array of option values for SELECT/RADIO/etc.), `displayOrder Int`; unique `(groupId, fieldKey)` | Belongs to `CustomFieldGroup` (cascade delete) |

**How values are stored (ADR-0002):** `CustomField` and `CustomFieldGroup` hold metadata only. Actual values live in the `customFields JSONB` column on the owning entity:

- `Ticket.customFields` for fields with `scope = TICKET`
- `User.customFields` for fields with `scope = USER`
- `Organization.customFields` for fields with `scope = ORGANIZATION`
- `scope = STAFF` is defined but not yet surfaced on the `Staff` model.

Keys in the JSONB object are the stable `fieldKey` strings. Encrypted fields (`isEncrypted = true`) are encrypted at the application layer before storage.

---

### 9. Knowledgebase

| Model                 | Key columns                                                                                                                                                                                  | Relations                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **KbCategory**        | `id`, `title`, `parentId?`, `displayOrder Int`, `isPublished Bool`                                                                                                                           | Self-relation "KbTree"; has many `KbArticle`              |
| **KbArticle**         | `id`, `categoryId?`, `title`, `slug` (unique), `contents` (current HTML), `contentsText` (plaintext for search), `isPublished Bool`, `views Int`, `authorStaffId?`, `createdAt`, `updatedAt` | Optional FK to `KbCategory`; has many `KbArticleRevision` |
| **KbArticleRevision** | `id`, `articleId`, `contents`, `editedByStaffId?`, `createdAt`                                                                                                                               | Belongs to `KbArticle` (cascade delete)                   |

A new revision is saved on every `PUT /api/kb/articles/:id` update.

---

### 10. News

| Model        | Key columns                                                                                                        | Relations |
| ------------ | ------------------------------------------------------------------------------------------------------------------ | --------- |
| **NewsItem** | `id`, `title`, `contents`, `isPublished Bool`, `publishedAt DateTime?`, `authorStaffId?`, `createdAt`, `updatedAt` | —         |

`publishedAt` is set to `now()` automatically when `isPublished` is first set to `true`.

---

### 11. Troubleshooter (branching guides)

| Model                      | Key columns                                                              | Relations                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **TroubleshooterCategory** | `id`, `title`, `parentId?`, `displayOrder Int`, `isPublished Bool`       | Self-relation "TsTree"; has many `TroubleshooterStep`                                                            |
| **TroubleshooterStep**     | `id`, `categoryId`, `title`, `contents`, `displayOrder Int`, `createdAt` | Belongs to `TroubleshooterCategory` (cascade delete); has many `TroubleshooterStepLink` (as "TsFrom" and "TsTo") |
| **TroubleshooterStepLink** | `id`, `fromId`, `toId`, `label`; unique `(fromId, toId)`                 | Belongs to `TroubleshooterStep` as source and target (both cascade delete)                                       |

Steps form a directed acyclic graph per category; outgoing links carry an optional `label` displayed as a button/choice in the client portal.

---

### 12. Reports

| Model              | Key columns                                                                                                                                   | Relations                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Report**         | `id`, `title`, `kind ReportKind`, `definition Json` (KQL-lite: `{ source, columns, filters, groupBy, aggregates }`), `createdAt`, `updatedAt` | has many `ReportSchedule`            |
| **ReportSchedule** | `id`, `reportId`, `cron String`, `recipients Json` (array of email addresses), `isEnabled Bool`                                               | Belongs to `Report` (cascade delete) |

`Report.definition` is a declarative JSONB descriptor. The current runtime supports a safe subset: `source: 'tickets'`, `groupBy` from a fixed allowlist, `filters` as key/value map, `metric: 'count'`. Full KQL is a planned future enhancement.

---

### 13. Settings

| Model       | Key columns                                                                 |
| ----------- | --------------------------------------------------------------------------- |
| **Setting** | `id`, `section String`, `key String`, `value Json`; unique `(section, key)` |

Replaces the Kayako EAV `swsettings` table. Values are typed JSONB, so booleans/numbers/strings are stored natively without string-coercion.

---

### 14. Alaris Integration

| Model           | Key columns                                                                                                                         | Relations                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **AlarisEvent** | `id`, `externalId` (unique — deduplication key), `severity String`, `payload Json`, `ticketId? Int` (unique), `receivedAt DateTime` | Optional one-to-one FK to `Ticket` |

One `AlarisEvent` maps to at most one `Ticket` (unique constraint on `ticketId`). The webhook deduplicates by `externalId`; repeated payloads with the same ID return the existing event without creating a duplicate ticket. See [ADR-0005](adr/0005-alaris-stub.md).

---

## Relationships — Ticket core

```
SlaPlan ──────────────── (optional)
                         │
Department ──┐           │
             │           │
TicketStatus─┤           ▼
             ├──────► Ticket ──────────── User (requester, optional)
TicketPriority┤         │                 │
             │           │                 └── UserEmail[]
TicketType──┘(optional)  │
                         ├── TicketPost[] ──── Staff (author, optional)
                         │                     └── Attachment[]
                         ├── TicketNote[]───── Staff (optional)
                         ├── Attachment[]
                         ├── TicketWatcher[] ─ Staff[]
                         ├── TicketTag[]
                         ├── TicketAuditLog[]─ Staff (optional)
                         ├── TicketLink[] (source/target self-join)
                         ├── mergedInto? ────► Ticket (self-relation)
                         └── AlarisEvent? (one-to-one)

Staff ──────────────────── ownerStaffId (optional FK on Ticket)
  └── StaffGroup (RBAC permissions[])
```

**Key cardinalities:**

- A `Ticket` belongs to exactly one `Department`, `TicketStatus`, `TicketPriority`; optionally to one `TicketType`, one `User` (requester), one `Staff` (owner), one `SlaPlan`.
- A `Ticket` has zero or more `TicketPost` (public replies), `TicketNote` (internal notes), `Attachment`, `TicketWatcher`, `TicketTag`, `TicketAuditLog`.
- Merging: a ticket may point to at most one surviving ticket via `mergedIntoId`; the surviving ticket may accumulate many `mergedFrom` tickets.
- `TicketLink` is a directed, typed relationship between two tickets (e.g. `related`, `duplicate`); enforced unique per `(sourceId, targetId)` pair.
- `Staff` belongs to exactly one `StaffGroup` and may be assigned to zero or more `Department` records via the `DepartmentStaff` join table.
- `Organization` may have an optional `SlaPlan` that is applied to all its `User` tickets by default.

---

## Enums

| Enum               | Values                                                                                                 | Used on                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `DepartmentType`   | `PUBLIC`, `PRIVATE`                                                                                    | `Department.type`                                                     |
| `UserGroupType`    | `GUEST`, `REGISTERED`                                                                                  | `UserGroup.type`                                                      |
| `ActorType`        | `STAFF`, `USER`, `SYSTEM`                                                                              | `Ticket.creator`, `TicketPost.authorType`, `TicketAuditLog.actorType` |
| `CreationMode`     | `WEB`, `EMAIL`, `API`, `STAFF`, `ALARIS`                                                               | `Ticket.creationMode`, `TicketPost.creationMode`                      |
| `CustomFieldScope` | `TICKET`, `USER`, `STAFF`, `ORGANIZATION`                                                              | `CustomFieldGroup.scope`                                              |
| `CustomFieldType`  | `TEXT`, `TEXTAREA`, `PASSWORD`, `CHECKBOX`, `RADIO`, `SELECT`, `MULTISELECT`, `DATE`, `FILE`, `CUSTOM` | `CustomField.type`                                                    |
| `SlaTargetType`    | `FIRST_RESPONSE`, `RESOLUTION`                                                                         | `EscalationRule.targetType`                                           |
| `EmailQueueType`   | `IMAP`, `POP3`, `PIPE`                                                                                 | `EmailQueue.type`                                                     |
| `FlagType`         | `NONE`, `PURPLE`, `ORANGE`, `GREEN`, `YELLOW`, `RED`, `BLUE`                                           | `Ticket.flagType`                                                     |
| `ReportKind`       | `TABULAR`, `SUMMARY`, `MATRIX`                                                                         | `Report.kind`                                                         |

---

## Indexes & constraints

### Unique constraints

| Table                    | Unique on                 |
| ------------------------ | ------------------------- |
| `Staff`                  | `email`; `username`       |
| `RefreshToken`           | `tokenHash`               |
| `UserEmail`              | `email`                   |
| `Ticket`                 | `mask`                    |
| `TicketTag`              | `name`                    |
| `TicketLink`             | `(sourceId, targetId)`    |
| `AlarisEvent`            | `externalId`; `ticketId`  |
| `KbArticle`              | `slug`                    |
| `EmailTemplate`          | `(key, locale)`           |
| `CustomField`            | `(groupId, fieldKey)`     |
| `TroubleshooterStepLink` | `(fromId, toId)`          |
| `Setting`                | `(section, key)`          |
| `DepartmentStaff` (PK)   | `(departmentId, staffId)` |
| `TicketWatcher` (PK)     | `(ticketId, staffId)`     |

### Indexes (non-unique)

| Table                | Indexed columns                                                                     |
| -------------------- | ----------------------------------------------------------------------------------- |
| `Staff`              | `staffGroupId`                                                                      |
| `RefreshToken`       | `staffId`                                                                           |
| `User`               | `organizationId`                                                                    |
| `UserEmail`          | `userId`                                                                            |
| `Ticket`             | `statusId`, `departmentId`, `ownerStaffId`, `userId`, `lastActivityAt`, `createdAt` |
| `TicketPost`         | `ticketId`, `messageId`                                                             |
| `TicketNote`         | `ticketId`                                                                          |
| `Attachment`         | `ticketId`, `postId`                                                                |
| `TicketAuditLog`     | `ticketId`                                                                          |
| `KbArticle`          | `categoryId`                                                                        |
| `KbArticleRevision`  | `articleId`                                                                         |
| `SlaHoliday`         | `scheduleId`                                                                        |
| `EscalationRule`     | `slaPlanId`                                                                         |
| `TroubleshooterStep` | `categoryId`                                                                        |
| `ReportSchedule`     | `reportId`                                                                          |

### JSONB columns

| Table.column                | Content                                                                      |
| --------------------------- | ---------------------------------------------------------------------------- |
| `Organization.customFields` | `{ [fieldKey]: value }` — custom field values (scope ORGANIZATION)           |
| `User.customFields`         | `{ [fieldKey]: value }` — custom field values (scope USER)                   |
| `User.geoip`                | Freeform GeoIP data from inbound email origin                                |
| `Ticket.customFields`       | `{ [fieldKey]: value }` — custom field values (scope TICKET)                 |
| `SlaSchedule.workHours`     | `{ mon: [["HH:MM","HH:MM"]], … }` — weekly operational hours                 |
| `SlaPlan.criteria`          | JSON rule array for auto-matching tickets to this plan                       |
| `EscalationRule.actions`    | JSON array of actions triggered on SLA breach                                |
| `Workflow.criteria`         | JSON condition set evaluated against ticket events                           |
| `Workflow.actions`          | JSON action list applied when criteria match                                 |
| `Macro.actions`             | JSON array of bulk actions applied with the macro                            |
| `CustomField.options`       | JSON array of option values (for SELECT, RADIO, MULTISELECT, CHECKBOX types) |
| `Report.definition`         | KQL-lite descriptor `{ source, groupBy, filters, metric }`                   |
| `ReportSchedule.recipients` | JSON array of recipient email addresses                                      |
| `AlarisEvent.payload`       | Raw Alaris event payload (freeform)                                          |
| `Setting.value`             | Arbitrary typed value (boolean, number, string, object)                      |
| `StaffGroup.permissions`    | `String[]` — permission key list (Postgres array, not JSONB)                 |

---

## Migrations

Migrations live under `apps/api/prisma/migrations/` and are managed by Prisma Migrate.

| Migration                                | Name                    | Contents                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260522130915_init`                    | init                    | Full initial schema — all core tables, enums, indexes                                                                                                                                    |
| `20260522131515_troubleshooter_reports`  | troubleshooter_reports  | Adds `TroubleshooterCategory`, `TroubleshooterStep`, `TroubleshooterStepLink`, `Report`, `ReportSchedule`                                                                                |
| `20260716000000_password_reset_template` | password_reset_template | Data-only idempotent upsert of the `password_reset` EmailTemplate (en). Ensures the reset flow has a template in **production**, where the seed does not run (GOAL_PUBLIC_SECURITY S1-4) |
| `20260716010000_staff_auth_version`      | staff_auth_version      | Adds `Staff.authVersion Int NOT NULL DEFAULT 0` for immediate session invalidation — embedded as the access-token `av` claim and checked by the JWT guard (GOAL_PUBLIC_SECURITY S3-1)    |

**Apply migrations (CI / production):**

```bash
npx prisma migrate deploy
```

**Apply + generate client (local dev):**

```bash
npm run prisma:migrate -w apps/api
# or directly:
npx prisma migrate dev --name <description>
```

---

## Seed

**Entry point:** `apps/api/src/seed/seed.ts` — run via `tsx src/seed/seed.ts` (also invoked automatically by `docker compose up --build`).

The seed is **idempotent** (uses upsert / find-or-create; safe to re-run). It creates:

| Category         | Items                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| StaffGroups      | `Administrator` (isAdmin, ALL_PERMISSIONS), `Agent` (ROLE_PRESETS.agent)                                                                                                                                                                                                                                     |
| Staff            | `admin@23telecom.example` / `demo1234`, `agent@23telecom.example` / `demo1234`                                                                                                                                                                                                                               |
| Departments      | `Support` (isDefault), `NOC`                                                                                                                                                                                                                                                                                 |
| TicketStatuses   | Open (default), Pending, In Progress, Resolved, Closed                                                                                                                                                                                                                                                       |
| TicketPriorities | Low, Normal, High, Urgent                                                                                                                                                                                                                                                                                    |
| TicketTypes      | Issue, Question, Incident, Alaris Incident                                                                                                                                                                                                                                                                   |
| SLA              | `Standard SLA` plan (first response 4 h, resolution 24 h) + `Standard Business Hours` schedule (Mon–Fri 09:00–18:00)                                                                                                                                                                                         |
| EmailTemplates   | `ticket_user_reply` (en + ru), `autoresponder` (en + ru), `sla_breach_internal` (en), `notify_staff_assigned` (en), `notify_staff_user_replied` (en), `password_reset` (en) — 8 template versions. `password_reset` is also provisioned in production via migration `20260716000000_password_reset_template` |
| Organizations    | `Acme Corp` (Moscow, RU, slaPlanId set), `Beta LLC` (Saint Petersburg, RU)                                                                                                                                                                                                                                   |
| Users            | Ivan Petrov, Maria Sidorova (Acme Corp), Dmitry Volkov (Beta LLC), Guest User                                                                                                                                                                                                                                |
| Demo Tickets     | 5 tickets covering Support + NOC departments, various priorities/types, first 2 with agent replies                                                                                                                                                                                                           |
