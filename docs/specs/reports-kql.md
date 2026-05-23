# Implementation Spec — Reports / KQL-style engine (parity P0)

Replace KQL-lite (single-table count + 1 groupBy) with a SAFE declarative engine (NO raw SQL — all via Prisma groupBy/aggregate/findMany + in-JS bucketing). Kayako had 82 KQL reports (MULTIGROUP BY, date buckets, relative dates, response-time avgs).

## P0 — declarative model + compiler

- `report-definition.schema.ts` (Zod): source ∈ {tickets,ticketPosts,ticketAuditLogs}; filters[] (whitelisted FILTERABLE_FIELDS per source; ops eq/neq/in/notIn + date eq/lt/lte/gt/gte/between with relative tokens today/thisWeek/lastMonth/last30days... or absolute); groupBy[] ≤3 (whitelisted GROUPABLE_FIELDS incl `createdAt:day|week|month` buckets); aggregates[] 1..5 (count|avg|sum|min|max; numeric fields whitelist incl computed firstResponseSeconds/resolutionSeconds); orderBy?; limit ≤1000. **Every field checked against whitelist → no injection.**
- `report-compiler.ts`: buildWhere (whitelist or throw), resolveDate(relative→Date), count+pure-column → prisma.groupBy fast path; date-bucket or avg/sum → findMany(select) + group/aggregate in JS (bucketDate, computed seconds). compile() switches by source.
- expand ReportsService; create()/update() validate definition via schema; run() re-parses stored definition (fixes P1-8 injection). Keep /reports/dashboard unchanged.
- schema: ReportSchedule += lastRunAt/nextRunAt/format; new ReportRun{reportId,triggeredBy,rowCount,durationMs,error,createdAt}; Report.runs[]. permissions REPORT_RUN/REPORT_MANAGE.

## P1 — schedule execution + UI

- `report-schedule.processor.ts` (@Processor('reports'), mirror SlaProcessor): OnModuleInit enqueue repeatable 'schedule-scan' every 5min → finds enabled schedules nextRunAt≤now → run → ReportRun + email results (toCsv) via MailService → advance nextRunAt (cron-parser).
- endpoints: CRUD /reports, GET/POST /reports/:id/run (+ ad-hoc filterOverrides), GET /reports/:id/runs, CRUD /reports/:id/schedules.
- Admin UI /admin/reports: ReportsList + ReportBuilderDialog (source/filters/groupBy/aggregates builders, RHF+zod) + ReportViewPanel (table + simple bar chart + Export CSV) + ScheduleDialog (cron+recipients+format). use-reports.ts hooks. Sidebar link + i18n.
- CSV: reports.utils.toCsv; GET ?format=csv → text/csv attachment.

## Ship 10 reports (seed)

P0: R-01 tickets by status (open), R-02 created over time (thisMonth/day), R-03 by department (open), R-04 staff workload, R-05 avg first-response by dept, R-06 SLA breach by priority. P1: R-07 resolved by week (lastQuarter), R-08 avg resolution by priority, R-09 staff activity from ticketAuditLogs (actorType=STAFF, groupBy staffId+action), R-10 by creationMode (thisYear).

## Tests

report-definition.schema.spec (reject unknown source, >3 groupBy, avg w/o field, relative/between parse), report-compiler.spec (whitelist reject, relative date range, count groupBy→prisma.groupBy, date-bucket JS grouping, avg computed, multi-groupBy, limit), report-schedule.processor.spec (skip disabled, ReportRun created, email on csv, error stored, lastRunAt updated).

## Files

CREATE: report-definition.schema.ts, report-compiler.ts(+spec), report-definition.schema.spec, reports.utils.ts, report-schedule.processor.ts(+spec), web admin/reports/{page,reports-content}.tsx, use-reports.ts, prisma/seed report-seeds.
MODIFY: reports.module.ts (compiler+schedule endpoints+BullModule.registerQueue('reports')+OnModuleInit scanner; keep /dashboard), schema.prisma (ReportSchedule fields + ReportRun), permissions.ts, admin layout nav + i18n. Optional P2: recharts.
NOTE: BullMQ pattern = copy SlaProcessor/AutoCloseProcessor; MailService.send already supports recipients.
