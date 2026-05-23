# FIX PLAN — 23 Telecom Help Desk

Живой трекер устранения находок QA-аудита (`QA_AUDIT_REPORT.md`). Каждый блок: фикс → тест → tsc/lint/vitest → (фронт) пересборка без кэша + Playwright реальным логином → commit.

Статусы: ☐ todo · ◐ in-progress · ☑ done (verified)

## Системные

- ☑ **S3** глобальный PrismaExceptionFilter (P2025→404, P2003→400, P2002→409) + тест. [api: filter+spec, app.module]
- ☑ **S2** PATCH→PUT: useUpdateWorkflow/Macro/SlaPlan [use-admin.ts:538,709,787]
- ☑ **S1** coerce ''→0→400: departments/SLA/staff формы + dto nullable
- ☑ **S5** `/admin` индекс-страница (redirect)
- ☑ **S7** `useMe` enabled:!!token (шумные 401)
- ☐ **S6** error-toast показывает детали API (админ-формы)

## P0 (backend — done в S3-блоке)

- ☑ P0-11 addNote findOrThrow→404 + ☑ P0-12/13 (Prisma filter) + ☑ P0-14 alaris BadRequestException
- ☑ MJ-1 письма {{name}} + ☑ MJ-3 alaris autoresponder skip

## P0 (frontend формы)

- ☑ P0-4 staff таблица limit=200→100 + isError
- ☑ P0-5 staff create: поле username (auto-derive)
- ☑ P0-6 custom-fields group: scope
- ☑ P0-7 custom-fields field: fieldKey + UPPERCASE типы
- ☑ P0-8 custom-fields: читать fields[] из списка (убрать 404-фетч)
- ☑ P0-9 departments parentId null (S1)
- ☑ P0-10 SLA edit (S2 ✓ — проверить)
- ☑ P0-1 login redirect /staff/dashboard + hard-nav (verify)
- ☐ P0-2/3 kanban DnD persist (@dnd-kit)

## P1 (кластерами)

- ☑ Ticket detail: статус/приоритет/ассайн(ownerStaffId)/закрыть + notes + авторы + dedup [TD-1,2,3,4,5,8,9,10,11] (◐ остаётся TD-6 отдел, TD-7 теги, TD-12 вложения, TD-13 макрос, TD-14 merge, TD-16 dup-id)
- ☐ Tickets list: server-side фильтры + счётчик + период [TL-1..3]
- ☐ Dashboard: реальные SLA/avg/тренды [DK-4,5]; CommandPalette enabled:open [DK-7]; closed-колонка [DK-8]
- ☐ Client: client_email запись + публичные detail/reply эндпоинты + dept dropdown [CL-1..5]
- ☐ Workflows/macros: билдеры, edit-кнопка макроса, категории, isShared [WF-2,3,4,6]
- ☐ SLA UI: расписания/праздники/эскалации [SLA-3,4,5]; ApiEscalationRule интерфейс [SLA-6]
- ☐ Staff: isEnabled toggle [ST-4]; KB: превью/счётчик/HTML [KB-1,2,3]
- ☐ Security: throttler login/public; KB-черновики; /tickets/my scope; HttpOnly cookie [RBAC-1,2; AU-1,2,4]

## Обнаружено в ходе фиксов

- ☐ React #418 hydration mismatch на SSR staff-страниц (обнажилось hard-nav; вероятно относительные даты/анимации) — разобрать в кластере dashboard/tickets

## P2/P3 + паритет — после P0/P1 (см. QA_AUDIT_REPORT.md)
