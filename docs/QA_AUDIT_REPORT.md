# QA-аудит «23 Telecom Help Desk» — 2026-05-23

Аудит проведён 15 параллельными агентами против живого стека (web :3000, API :4000, MailHog :8025) реальным логином + проверкой API. Каждая кнопка/форма прокликана через Playwright, каждый эндпоинт проверен curl'ом против Swagger. Сравнение с оригинальным Kayako — отдельный gap-анализ.

**Итого: ~120 находок.** Ядро (auth-механика, БД, БullMQ-jobs, IMAP/SMTP, адаптеры списков тикетов, RBAC-инфраструктура) — крепкое и работает. Но **админка и управление тикетом во многом не дописаны до конца**: формы шлют не то, что ждёт API, а ряд контролов — заглушки.

---

## СИСТЕМНЫЕ ПАТТЕРНЫ (чинить в первую очередь — каждый закрывает много багов)

### S1. `z.coerce.number()` превращает пустой select в `0` → 400 (3 формы)

Native `<select>` отдаёт `""`, `z.coerce.number("")` → `0`, API требует `positive()`/отвергает `null`.
**Где:** departments (parentId), SLA (scheduleId), staff (staffGroupId).
**Фикс:** в форме `z.preprocess(v => v === '' || v === 0 ? undefined : v, z.number().int().positive().optional())`, а опциональные FK в API сделать `.nullable().optional()`.

### S2. `useUpdate*` шлёт `PATCH`, а бэкенд регистрирует только `PUT` → 404 (3 модуля)

**Где:** `useUpdateWorkflow` (use-admin.ts:708), `useUpdateMacro` (:787), `useUpdateSlaPlan` (:538).
**Фикс:** `api.patch` → `api.put` в этих хуках.

### S3. Нет глобального exception-фильтра Prisma → 500 вместо 404/400 (≥7 эндпоинтов)

**Где:** `main.ts` без global filter; FK-нарушения и `P2025` всплывают как 500.
**Фикс:** добавить `APP_FILTER` PrismaExceptionFilter (P2025→404, P2003 FK→400, P2002 unique→409). Закрывает API-1..7.

### S4. Контрол показан, но не подключён к API (display-only / hardcoded mock)

Управление тикетом, kanban-DnD, ассайн, custom-fields, фильтры, нотификации.

### S5. `/admin` нет индекс-страницы → 404 при каждом заходе staff (ссылка «Настройки»)

**Фикс:** создать `app/(admin)/admin/page.tsx` с `redirect('/admin/departments')`.

### S6. Generic error-toast глотает детали API (400/409 issues[]) во всех админ-формах.

### S7. Шумные `GET /auth/me → 401` на всех публичных/неавторизованных страницах.

**Фикс:** `useMe` — `enabled: !!token`.

---

## P0 — БЛОКЕРЫ (продукт не работает в этих местах)

| #     | Область             | Баг                                                                                                                                                 | Файл                                             | Фикс                                                                                                                                    |
| ----- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1  | Login               | После входа staff/admin попадает на КЛИЕНТСКИЙ портал `/tickets`, не в `/staff/dashboard` (admin/agent оба — staff, клиенты тут не логинятся вовсе) | `(client)/login/page.tsx`, `LoginScreen.tsx:108` | redirectTo→`/staff/dashboard` + hard-nav `window.location.assign` (router.push перебивается) **[ИСПРАВЛЕНО, ждёт пересборки+проверки]** |
| P0-2  | Kanban              | Drag-and-drop НЕ сохраняет статус — только локальный стейт, ревертится на reload                                                                    | `KanbanBoard.tsx:155`                            | `onDragEnd` → `useUpdateTicket({status})`                                                                                               |
| P0-3  | Kanban              | Cross-column drag архитектурно невозможен (`framer Reorder.Group` по колонке)                                                                       | `KanbanBoard.tsx:118`                            | заменить на `@dnd-kit`                                                                                                                  |
| P0-4  | Admin staff         | Таблица staff вообще не грузится: `GET /staff?limit=200` → 400 (max 100) → пустая страница, все операции недоступны                                 | `use-admin.ts:613`                               | `limit=100`                                                                                                                             |
| P0-5  | Admin staff         | Создание staff всегда 400 — в форме нет `username`, который требует API                                                                             | `staff-content.tsx:188`, `dto.ts:13`             | добавить поле / авто-генерация из email                                                                                                 |
| P0-6  | Admin custom-fields | Создание группы всегда 400 — форма не шлёт `scope`                                                                                                  | `use-admin.ts:822`                               | добавить scope (default TICKET)                                                                                                         |
| P0-7  | Admin custom-fields | Создание поля всегда 400 — нет `fieldKey` + типы lowercase vs API uppercase                                                                         | `custom-fields-content.tsx:24`, `dto.ts:18`      | fieldKey (авто-slug) + UPPERCASE типы                                                                                                   |
| P0-8  | Admin custom-fields | `GET /custom-field-groups/:id/fields` → 404 (роута нет) → все группы «0 полей»                                                                      | `use-admin.ts:810`                               | читать `fields[]` из ответа списка                                                                                                      |
| P0-9  | Admin departments   | Создание/редактирование отдела всегда 400 — шлёт `parentId:null` (S1)                                                                               | `departments-content.tsx:47`, `dto.ts:9`         | S1                                                                                                                                      |
| P0-10 | Admin SLA           | Редактирование плана PATCH → 404 (S2)                                                                                                               | `use-admin.ts:538`                               | S2                                                                                                                                      |
| P0-11 | API                 | `POST /tickets/:id/notes` → 500 на несуществ. id (нет findOrThrow)                                                                                  | `tickets.service.ts:373`                         | S3 / findOrThrow                                                                                                                        |
| P0-12 | API                 | `GET /reports/:id/run` → 500 на несуществ. id                                                                                                       | `reports.module.ts:43`                           | S3                                                                                                                                      |
| P0-13 | API                 | `PUT /news/:id` → 500 на несуществ. id                                                                                                              | `news.module.ts:32`                              | S3                                                                                                                                      |
| P0-14 | API/Alaris          | `POST /alaris/webhook` без полей → 500 (`throw new Error`)                                                                                          | `alaris.controller.ts:50`                        | `BadRequestException`                                                                                                                   |
| P0-15 | Security            | Нет rate-limit на `/api/auth/login` → brute-force                                                                                                   | `auth.controller.ts:28`                          | `@nestjs/throttler`                                                                                                                     |

---

## P1 — КРИТИЧНЫЕ (фича заявлена, но не работает/опасна)

### Безопасность

- **RBAC-1**: черновики KB читаются публично (`GET /kb/articles` publishedOnly default false + `getArticleBySlug` без isPublished) — `knowledgebase.service.ts:39,71`.
- **RBAC-2**: `GET /tickets/my?email=` — перечисление тикетов по любому email без авторизации (утечка тем/статусов) — `tickets.controller.ts:76`. Фикс: OTP/magic-link или хотя бы rate-limit.
- **AU-2**: нет rate-limit на `/tickets/public` (спам/DoS). **AU-3**: слабые JWT-секреты закоммичены в `.env`. **AU-4**: cookie `auth_token` не `HttpOnly` → XSS крадёт JWT.

### Управление тикетом (staff detail) — панель display-only

- Нет смены **статуса** (TD-3), **приоритета** (TD-4), **отдела** (TD-6), **тегов** (TD-7); нет кнопки **закрыть/решить** (TD-8) — `useUpdateTicket` есть, но не вызывается.
- Смена **исполнителя** косметическая: только toast, без API (TD-5), + неверное поле `{staffId}` vs схема `{ownerStaffId}` → 400 (TD-9). `use-tickets.ts:285`.
- Авторы постов = «—» (маппер не резолвит staffId; сервер пишет пустые fullName/email) — TD-1.
- Внутренние заметки не отображаются (`notes[]` игнорируется, `is_internal` всегда false) — TD-2.

### Списки/фильтры

- Фильтры статуса/приоритета только клиентские → теряют тикеты со стр. 2+ (TL-1); счётчик показывает total API, не отфильтрованный (TL-2); фильтр «Период» декоративный (TL-3).

### Dashboard

- `sla_breached`/`avg_first_response`/тренды захардкожены 0/+5%/+12% (DK-4, DK-5).
- CommandPalette дёргает `/tickets?limit=5` на каждой странице (DK-7); «Closed» тикеты пропадают с kanban (DK-8); лимит kanban 50 (DK-9).

### Admin (формы/CRUD)

- Workflows/macros: нет билдеров условий/действий → при edit criteria/actions затираются (WF-2); нет edit-кнопки макроса (WF-3); нет UI категорий (WF-4); `isShared` теряется (WF-6).
- SLA: «Без графика» → scheduleId=0 → 400 (S1, SLA-2); нет UI расписаний/праздников/эскалаций (SLA-3/4/5).
- Staff: «Без группы»→0→400 (S1, ST-3); нет UI отключить/включить, soft-delete односторонний (ST-4); нет error-состояния таблицы (ST-5).
- Custom-fields: `isEditable` без колонки в БД (CF-4); custom-fields нигде не появляются в форме тикета (CF-6).

### Клиентский портал (self-service нерабочий для реальных юзеров)

- `client_email` нигде не записывается → «Мои заявки» всегда пусто (CL-3).
- `GET /tickets/public/:id` и `POST /tickets/public/:id/reply` отсутствуют на бэке → деталь/ответ клиента всегда падают (CL-4, CL-5).
- Захардкоженные dept-id (1/2/3) ≠ БД (1,2); NOC id=3 → 500 (CL-2); ошибка submit молча проглатывается (CL-1).

### KB / Mail / API

- KB: пустой превью карточек (KB-1), счётчик «0 статей» (KB-2).
- Mail: во ВСЕХ письмах «Hello ,» — шаблон `{{name}}`, код шлёт `requesterName` (MJ-1). `tickets.service.ts:160,358`.
- API: нет FK-валидации → 500 при создании tickets/users/orgs с битым FK (S3, API-5/6/7).

---

## P2 / P3 — улучшения (полный список в `/tmp/qa-audit/*.md`)

KB: raw-HTML рендер (нужен dangerouslySetInnerHTML), нет voting/related/TOC. Пагинация API в 3 форматах. `/tickets/my` требует email даже с JWT. Нет пагинации/сортировки/bulk/«новый тикет» в списке. Стат-карты не кликабельны. Меню «Профиль/Настройки» мёртвые. Имя = email (не fullName). Нотификации = mock. Нет middleware.ts и APP_GUARD-бэкстопа. DialogDescription (a11y). Слабый Alaris-секрет. Тосты/валидация числовых полей не показываются.

---

## ПАРИТЕТ С KAYAKO (виабилити-гэпы для миграции)

**Реализовано полностью:** тикеты (lifecycle/merge/split/notes/watchers/tags/audit), статусы/приоритеты/типы/флаги, SLA (планы/расписания/праздники/эскалация+breach), workflows, macros, users/orgs/multi-email, staff/группы/права/подписи, дерево отделов, KB, troubleshooter, news, settings, шаблоны, IMAP-in/SMTP-out, Alaris (намеренная заглушка).

**P0-гэпы:** загрузка **вложений** сломана end-to-end (UI есть, бэка нет; 1791 в проде); **CC/BCC** не хранятся (3882 строк потеряются при миграции); **apply-macro** к тикету нет (есть CRUD, применить нельзя); нет CRUD **email-очередей**; **отчёты ~5%** от Kayako (82 KQL-отчёта); пароли IMAP не расшифровываются (TODO) → mail-in для прод-очередей упадёт.

**P1-гэпы:** парсер-правила входящей почты, нотификации персоналу, time-tracking, расширенные действия эскалации, follow-ups, сохранённые виды тикетов, POP3, workflow-email.

**Риски миграции данных:** CC/BCC, формат маски `XJI-989-74107`→`TT-000042`, перенос вложений chunk→storageKey, EAV custom-fields→JSONB, dept-scoped статусы/типы.

---

## РЕКОМЕНДУЕМЫЙ ПОРЯДОК

1. **Системные S1–S3, S5, S7** — закрывают ~25 багов малой кровью (coerce→null, PATCH→PUT, Prisma-фильтр, /admin index, enabled:!!token).
2. **P0 staff/custom-fields/departments/SLA формы** — оживить админку (поля username/scope/fieldKey/limit).
3. **Управление тикетом** — подключить `useUpdateTicket` к статусу/приоритету/ассайну (+ `ownerStaffId`), показать notes.
4. **Kanban DnD** на @dnd-kit с персистом.
5. **Клиентский портал** — `client_email` + публичные эндпоинты detail/reply.
6. **Безопасность** — throttler, HttpOnly cookie, секреты, KB-черновики, scope `/tickets/my`.
7. **Mail `{{name}}`**, dashboard-метрики, фильтры server-side.
8. **Паритет** — вложения, CC/BCC, apply-macro, email-queue CRUD, отчёты.
