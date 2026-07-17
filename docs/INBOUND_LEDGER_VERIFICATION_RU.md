# Как проверить: durable InboundDelivery ledger (production-ready inbound)

Дата: 2026-07-17
Ветка: `claude/inbound-delivery-ledger` (от актуального `origin/main` = `9b48fa8`)
Область: полностью переработанный входящий поток (IMAP + PIPE) поверх durable-леджера.
Закрывает 7 блокеров из повторного ревью PR #6. PR #6 **не** тронут (без force-push, без merge).

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
