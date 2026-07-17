# Как проверить: durable InboundDelivery ledger (production-ready inbound)

Дата: 2026-07-17
Ветка: `claude/inbound-delivery-ledger` (от актуального `origin/main` = `9b48fa8`)
Область: полностью переработанный входящий поток (IMAP + PIPE) поверх durable-леджера.
Закрывает 7 блокеров из повторного ревью PR #6. PR #6 **не** тронут (без force-push, без merge).

> **Раунд 2 (после 3-го ревью).** Дополнительно закрыты 10 пунктов + false-green тесты —
> см. раздел **«12. Раунд 2»** в конце. Быстрая проверка: `cd apps/api && npm install &&
npx prisma generate && npx vitest run src/modules/mail src/modules/tickets src/auth
--reporter=dot` → **265 passed**, `npx tsc --noEmit` и `eslint` чисто. На чистом чекауте
> сначала `npm install` в КОРНЕ монорепо (иначе eslint не поднимется).

## 1. Что сделано (по блокерам ревью)

| Блокер                               | Было                                                                               | Стало                                                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0-1** «карантин удаляет письмо»   | после 5 любых ошибок UID считался обработанным, cursor двигался, raw не сохранялся | Каждое письмо durably сохраняется в `InboundDelivery` (raw MIME) со state-машиной `ACCEPTED→PROCESSING→PROCESSED/RETRY/QUARANTINED`. Инфра-ошибка → `RETRY` (backoff), исчерпание → `QUARANTINED` с сохранённым raw для replay. Cursor двигается только по факту durable-accept, а не по исходу обработки. |
| **P0-2** bootstrap-гонка             | baseline на первом poll (через 60с) → письма между connect и poll терялись         | Baseline фиксируется **синхронно при connect**. Политика `FROM_NOW` / `BACKFILL`. Никогда не fail-open в `1:*`.                                                                                                                                                                                            |
| **P0-3** UIDVALIDITY fail-open       | авто-переустановка high-water → пропуск писем в новом UID-space                    | Fail-closed: `syncState=NEEDS_RECONCILIATION`, очередь **останавливается**, оператор выбирает `FROM_NOW`/`BACKFILL`.                                                                                                                                                                                       |
| **P1-4** атомарность                 | messageId писался follow-up UPDATE, ретрай после сбоя → дубль/частичная обработка  | messageId пишется в тот же Prisma `create`, что и пост. Ретрай ловится дедупом → без второго поста.                                                                                                                                                                                                        |
| **P1-5** out-of-order без Message-ID | дубли при повторной обработке                                                      | Идемпотентность прежде всего по `(queueId, uidValidity, uid)` (unique transportKey — atomic claim). Плюс дедуп по **effective Message-ID**: реальный или синтетический `<inbound-<sha256>@23telecom.local>` из хэша контента.                                                                              |
| **P1-6** multi-poller                | check-then-act, немонотонный cursor                                                | Atomic claim (unique transportKey INSERT) + монотонный CAS cursor (`updateMany where lastSeenUid < cursor`) + best-effort advisory lock.                                                                                                                                                                   |
| **P1-7** тестовые пробелы            | mask-error swallow и messageId не покрыты                                          | Прямые тесты: NotFound→новый тикет; non-NotFound→проброс без создания; фактический `messageId` внутри Prisma `create` (не только в mock).                                                                                                                                                                  |

Сохранено из `main`: shared `ingestRawMessage`/PIPE `/api/inbound/pipe`, loop/bounce guard,
References cleaning, mask requester-ownership guard, trusted `creationMode`/`ipAddress`,
security/RBAC-тесты.

## 2. Быстрая проверка (2–3 минуты)

```bash
cd /home/user/KAYAKA_style_HD/apps/api
npm install && npx prisma generate     # на чистом чекауте

npx vitest run src/modules/mail src/modules/tickets src/auth --reporter=dot
#   → ожидается: 249 passed
npx tsc --noEmit
npx eslint "src/modules/mail/**/*.ts" "src/modules/tickets/tickets.service.ts" --max-warnings=0
```

Ключевые тесты (`src/modules/mail/inbound.service.spec.ts`) — матрица ревью:

- accept: `advances the cursor via monotonic CAS`, `out-of-order … no loss`,
  `fail-closed: fetch error … WITHOUT advancing`, `fail-closed: ledger DB error … does NOT advance`,
  `duplicate transport key (P2002) … no-op … cursor still advances`, `EXPUNGE-vanished … advances past`,
  `UIDVALIDITY change HALTS the queue`, `halted queue … does not fetch`.
- bootstrap: `FROM_NOW records high-water and imports nothing`.
- drain: `PROCESSED`, `CAS race (count 0) → no-op`, `transient … RETRY … raw retained`,
  `exhausted → QUARANTINED (never discarded)`, `missing rawMime → QUARANTINED`.
- routing: dedup SKIPPED, synthetic Message-ID, mask ownership (owner/attacker),
  `IN-10: NotFound → new ticket`, `IN-10: non-NotFound error propagates`.
- атомарность (`tickets.service.spec.ts`): `createTicket writes messageId … in the SAME Prisma create`,
  `reply writes messageId … in the SAME Prisma create`.

### Анти-false-green (мутации, которые ДОЛЖНЫ ломать тесты)

1. Вернуть fail-open cursor (двигать cursor в `catch`) → упадут `fail-closed` тесты.
2. Убрать `if (!(err instanceof NotFoundException)) throw err` → упадёт `IN-10: non-NotFound … propagates`.
3. Убрать `...(dto.messageId ? { messageId } : {})` из Prisma `create` → упадут атомик-тесты.
4. Двигать cursor при UIDVALIDITY-смене → упадёт `HALTS the queue`.

## 3. Ручная проверка кода

- `apps/api/prisma/schema.prisma` — модели `InboundDelivery` (unique `transportKey`, `rawMime`,
  state enum) и поля `EmailQueue` (`lastSeenUid`, `uidValidity`, `syncState`).
  Миграция: `prisma/migrations/20260717000000_inbound_delivery_ledger/migration.sql`.
- `inbound.service.ts`:
  - `pollQueue` — UID discovery → `fetchOne` ascending → `acceptImapMessage` (durable) → CAS cursor;
    `catch → break` без advance; UIDVALIDITY-ветка → `syncState=NEEDS_RECONCILIATION`.
  - `bootstrapQueue` — синхронно при `connectQueue`; `resolveHighWaterUid`; никогда `1:*`.
  - `processDelivery` — CAS-claim → `processRawMessage` → PROCESSED/RETRY/QUARANTINED (raw kept).
  - `processRawMessage` — effective Message-ID (реальный/синтетический), dedup, thread/create,
    fail-closed mask.
- `tickets.service.ts` — `reply()`/`createTicket()` пишут `messageId` в тот же `create`.

## 4. Обязательный pre-cutover gate (инфраструктура, не в этом окружении)

Юнит-тесты моделируют IMAP через fake ImapFlow. Перед реальным cutover прогнать на живом
IMAP (GreenMail/Dovecot — **не** MailHog, у него нет IMAP EXPUNGE/UIDVALIDITY). Метод
`InboundMailService.pollNow()` запускает один accept+drain немедленно. Сценарии:

1. APPEND письма → один тикет + `InboundDelivery.state=PROCESSED`.
2. EXPUNGE старого письма + APPEND нового → новое обработано ровно один раз (UID, не sequence).
3. Рестарт/повторный poll → без дублей (unique transportKey).
4. Письмо без Message-ID, доставленное дважды → один тикет (синтетический id).
5. Пересоздание mailbox (UIDVALIDITY) → очередь встаёт в `NEEDS_RECONCILIATION`.
6. БД недоступна > 5 poll → cursor не двигается; после восстановления — ровно один пост.
7. Интеграционный `npm run test:integration` (Testcontainers Postgres) прогоняет PIPE→тикет→
   dedup→threading через реальный леджер и миграцию.

## 5. Осознанные остатки (честно)

- Полная транзакционность счётчиков/audit тикета вместе с постом (LIFE-03) — отдельный
  follow-up; леджер уже гарантирует отсутствие потерь и дублей постов.
- Raw MIME хранится inline; очень большие письма стоит выносить в object storage (`rawStorageKey`).
- Advisory-lock — best-effort; корректность держится на unique transportKey, а не на локе.
- Live-IMAP прогон (раздел 4) авторизован как обязательный ручной gate, но в этом окружении
  (без Docker/GreenMail) не запускался.

## 6. Дальше по аудиту (отдельными PR)

SEC-01 (аутентификация клиентского портала — Internet-facing, приоритет) → ACL-01 (department
scoping) → OUT-01 (durable outbox / честный статус доставки) → репетиция миграции Kayako и cutover.

---

## 12. Раунд 2 — что закрыто (10 пунктов + false-green)

Коммиты `5fabf2d`..`a324c3d` (все на этой ветке, обычные коммиты, без force-push).

| #           | Пункт                                 | Как проверить                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| false-green | 3 теста не проверяли то, что заявляли | Мутации: снять 3-й `{uid:true}` у `fetch` / вызов bootstrap в `connectQueue` / запись `rawMime` — каждое роняет тест `inbound.service.spec.ts` (`passes { uid: true }…`, `P0-2: connectQueue captures the baseline…`, `accepts new UIDs…rawMime`).             |
| #6          | небезопасный advisory-lock            | удалён; корректность на unique claim + CAS.                                                                                                                                                                                                                    |
| #7 (flag)   | `TELECOM_HD_IMAP_ENABLED` не читался  | теперь гейтит поллер (`onModuleInit`).                                                                                                                                                                                                                         |
| **#1**      | stale `PROCESSING` навсегда           | lease (`leaseOwner`/`leaseExpiresAt`): claim реклеймит протухший `PROCESSING`; settle lease-gated; startup-drain. Тесты `drain — retry/quarantine` + `reclaims a stale PROCESSING…`.                                                                           |
| **#2**      | миграция теряла письма                | миграция ставит enabled IMAP-очереди в `NEEDS_RECONCILIATION` + копирует legacy Setting-курсор; `bootstrapQueue` не FROM_NOW-ит halted.                                                                                                                        |
| **#4**      | check-then-act dedup                  | partial-unique index на непустой `InboundDelivery.messageId`; claim эффективного Message-ID (P2002→SKIPPED). Тесты `#4: stamps…`, `#4: concurrent duplicate loses…`.                                                                                           |
| **#3**      | LIFE-03 частичная обработка           | `reply()`: пост+attachments+counters+audit в одной `$transaction`. Тест `LIFE-03: reply runs … in a single $transaction`.                                                                                                                                      |
| **#5**      | cursor из старого UID-space           | `cursorGeneration` + CAS gated (generation/uidValidity/syncState/isEnabled); bootstrap CAS на `uidValidity IS NULL`.                                                                                                                                           |
| **#7**      | нет reconnect/reconcile               | supervisor `reconcileConnections()` (connect/disconnect по enabled); API `POST /admin/email-queues/{id}/reconcile`, `GET …/inbound/quarantine`, `POST …/replay`; `syncState` в ответе очереди.                                                                 |
| **#8**      | PIPE не byte-safe                     | `main.ts` свои body-parsers: raw `message/rfc822`/`octet-stream` как Buffer + лимит `TELECOM_HD_INBOUND_MAX_MB`; коллизия `x-inbound-delivery-id`↔contentHash → 409. Тесты в `inbound.controller.spec.ts` + `ingestRawMessage (PIPE) — delivery-id collision`. |
| **#9**      | orphan-вложения / swallow             | attachments staged лениво (loop/skip/ignore не грузят файлы); DB-ошибка parser-rule → rethrow (RETRY).                                                                                                                                                         |
| **#10**     | Int32 overflow UID + прочее           | `lastSeenUid`/`uid` → BigInt; dept-snapshot при acceptance; заполнение envelope/subject/messageId в леджере; self-loop с `Name <addr>`.                                                                                                                        |

### Анти-false-green (мутации, которые ДОЛЖНЫ ронять тесты)

1. Снять `inboundDelivery.update` (atomic claim) → `#4: concurrent duplicate…` зелёным НЕ останется.
2. Вернуть `reply()` к не-транзакционному → `LIFE-03: reply runs … in a single $transaction` падает.
3. Убрать generation/syncState-guard из cursor CAS → `accepts new UIDs … monotonic CAS` падает.
4. Игнорировать Buffer body в контроллере → `#8: accepts a raw Buffer body` падает.

### CI (осознанно НЕ добавлено)

`CLAUDE.md` явно запрещает CI («No CI/CD… Do not add CI»). Поэтому GitHub Actions не добавлял;
тесты гоняются локально (`npm test` / vitest). Это hard-constraint репозитория, не пропуск.

### Обязательный live-gate (не в этом окружении — нет Docker/GreenMail/PG)

Юнит-слой (265 тестов) моделирует IMAP через fake ImapFlow и Prisma-моки. Перед cutover прогнать
на реальном IMAP (GreenMail/Dovecot) + реальном Postgres через `InboundMailService.pollNow()`:
restart-recovery (lease), EXPUNGE, UIDVALIDITY halt+reconcile, DB-outage > 5 poll (cursor стоит),
два поллера (unique claim / CAS), upgrade со старого Setting-курсора. Testcontainers-спек
`inbound.int-spec.ts` (PIPE→ticket→dedup→threading) гоняется через `npm run test:integration`.
