# Как проверить исправления входящей почты (IMAP inbound P0)

Дата: 2026-07-16
Ветка: `claude/email-ticket-management-audit-7y8mfi`
Область этого PR: **P0-блокеры входящего IMAP-потока** из
`EMAIL_TICKET_MANAGEMENT_FIX_PLAN_RU.md` — пункты **IN-01, IN-02, IN-03, IN-10**.

> ⚠️ Это НЕ весь аудит. Осознанно сделан один связный, полностью протестированный
> вертикальный срез (самые критичные и наиболее автономные P0). Остальные P0/P1
> (SEC-01 портал, ACL-01 отделы, OUT-01 outbox, миграция Kayako и т.д.) в этот PR
> не входят — см. раздел «Что НЕ входит».

---

## 1. Что исправлено

| ID        | Было (баг)                                                                                                                                                                                                                                         | Стало (фикс)                                                                                                                                                                                                                                                             | Файл                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- |
| **IN-01** | `{ uid: true }` передавался во **2-м** аргументе `fetch()` (query), поэтому `<uid>:*` трактовался как **sequence range**. После `EXPUNGE` sequence-номера расходятся с UID — новые письма могли тихо перестать поступать. UIDVALIDITY не хранился. | `{ uid: true }` теперь **3-й** аргумент `fetch(range, query, options)` — настоящий UID-range. UIDVALIDITY хранится вместе с курсором; его смена вызывает контролируемый rebootstrap.                                                                                     | `inbound.service.ts` |
| **IN-02** | Первый запуск без watermark читал `1:*` — импортировал весь INBOX и мог разослать autoresponder старым клиентам.                                                                                                                                   | Первый poll (и смена UIDVALIDITY) ставит курсор в `uidNext-1` и **ничего не импортирует** (bootstrap NOW).                                                                                                                                                               | `inbound.service.ts` |
| **IN-03** | Одно «ядовитое» письмо, кидающее ошибку, блокировало все последующие UID навсегда; повторная обработка создавала дубли.                                                                                                                            | Письма обрабатываются строго по возрастанию UID. Сбойное письмо ретраится до `MAX_POISON_ATTEMPTS` (5) **без** сдвига watermark, затем помещается в карантин (лог) и курсор идёт дальше. Плюс идемпотентность: письмо, чей `Message-ID` уже есть на посте, пропускается. | `inbound.service.ts` |
| **IN-10** | `catch {}` в mask-пути ловил ЛЮБУЮ ошибку как «тикет не найден» и создавал новый тикет (иногда после частичного reply).                                                                                                                            | Fall-through к созданию нового тикета — только на `NotFoundException`. Транзиентные/DB-ошибки пробрасываются в retry/quarantine.                                                                                                                                         | `inbound.service.ts` |

Формат watermark изменён с «голого числа» на `{ uid, uidValidity }`; старые значения
читаются и прозрачно апгрейдятся (без rebootstrap и потери писем).

---

## 2. Быстрая автоматическая проверка (2 минуты)

```bash
cd /home/user/KAYAKA_style_HD/apps/api

# 1) Юнит-тесты входящей почты (9 новых тестов + существующие)
npx vitest run src/modules/mail/inbound.service.spec.ts --reporter=dot
#   → ожидается: 25 passed

# 2) Смежные модули не сломаны
npx vitest run src/modules/mail src/modules/tickets --reporter=dot
#   → ожидается: 164 passed

# 3) Типы и линт чисты
npx tsc --noEmit && npx eslint "src/modules/mail/inbound.service.ts" "src/modules/mail/inbound.service.spec.ts" --max-warnings=0
#   → ожидается: без ошибок
```

Новые тесты (файл `inbound.service.spec.ts`) — каждый привязан к пункту аудита:

- **IN-01** — `passes { uid: true } as the THIRD fetch() argument` (упадёт на старом
  2-аргументном коде).
- **IN-01** — `a UIDVALIDITY change triggers a controlled rebootstrap`.
- **IN-02** — `first connect (no watermark) bootstraps to uidNext-1 WITHOUT importing history`.
- **IN-03** — `a poison message stops the poll without advancing the watermark`.
- **IN-03** — `a poison message is quarantined after MAX attempts so later mail is delivered`.
- **IN-03** — `skips a message whose Message-ID was already stored on a post`
  и `creates a ticket when the Message-ID has not been seen before` (через реальный `simpleParser`).
- плюс: legacy bare-number watermark и монотонность курсора.

---

## 3. Ручная проверка кода (что читать глазами)

Открыть `apps/api/src/modules/mail/inbound.service.ts`, метод `pollQueue`:

1. **IN-01 — позиция аргумента.** Найти вызов `client.fetch(...)`. Должно быть
   `fetch(\`${'${lastUid + 1}'}:\*\`, { envelope: true, source: true }, { uid: true })`—`{ uid: true }`именно **третьим** аргументом. (В imapflow сигнатура`fetch(range, query, options)`, и только `options.uid` делает range UID-диапазоном.)
2. **IN-02 — bootstrap.** Ветка `if (watermark === null || validityChanged)` ставит
   `startUid = uidNext - 1` и делает `return` **до** цикла обработки — история не читается.
3. **IN-03 — монотонность.** В цикле `cursor` двигается только:
   - на успешной обработке (`cursor = msg.uid`), или
   - при карантине (после `MAX_POISON_ATTEMPTS`).
     При обычном сбое — `break` без сдвига → письмо и всё, что после него, ретраится.
     **Ключевой инвариант: watermark никогда не перепрыгивает необработанное письмо.**
4. **IN-10 — тип исключения.** В mask-пути `catch (err) { if (!(err instanceof
NotFoundException)) throw err; ... }`. Только `NotFoundException` ведёт к созданию
   нового тикета.

---

## 4. (Опционально) Проверка на живом IMAP

Юнит-тесты используют фейковый ImapFlow. Для настоящей проверки:

```bash
docker compose up -d mailhog   # или любой dev IMAP (greenmail/dovecot)
```

Сценарии, которые стоит воспроизвести вручную (соответствуют матрице аудита §8):

1. **EXPUNGE-дрейф:** положить 3 письма, обработать; удалить первое (EXPUNGE);
   прислать новое — оно должно обработаться ровно один раз (UID, а не sequence).
2. **Bootstrap NOW:** подключить очередь к ящику с уже лежащими письмами — новых
   тикетов быть не должно; курсор = текущий максимум.
3. **UIDVALIDITY:** пересоздать ящик (смена UIDVALIDITY) — контролируемый rebootstrap,
   без тихой потери и без реимпорта.
4. **Poison:** прислать заведомо битый MIME между двумя валидными — после N ретраев
   он уходит в карантин, следующее письмо обрабатывается.

---

## 5. Что НЕ входит в этот PR (осознанно)

Эти пункты аудита остаются открытыми и требуют отдельных срезов (часть — со схемой БД
и миграциями):

- **IN-04/IN-05, Этап 7** — импорт legacy Kayako masks / Message-ID, конфликт IMAP↔PIPE.
- **IN-06** — полностью атомарный дедуп (durable `InboundDelivery` ledger). Здесь сделан
  прагматичный дедуп по `Message-ID` (check-then-act) — он закрывает ретраи/краши, но не
  гонку двух параллельных поллеров; счётчик ретраев — in-memory (сбрасывается на рестарте).
- **IN-08** — queue supervisor (reconnect/reconcile при disable/смене пароля без рестарта).
- **IN-13..IN-20** — Reply-To/CC, HTML sanitize, bounded MIME/attachment policy, PIPE raw
  endpoint, self-loop guard, POP3 422 и т.д.
- **OUT-01..OUT-14** — durable outbox, честный «Sent», вложения в SMTP MIME, Message-ID chain.
- **SEC-01/SEC-02/ACL-01** — аутентификация клиентского портала, merge-изоляция, department scoping.

Приоритетная очередь на следующий срез: **SEC-01 (портал)** и **ACL-01 (отделы)** —
это оставшиеся P0 по безопасности; затем **OUT-01 (outbox/честный статус доставки)**.

---

## 6. Критерий приёмки этого среза

- [ ] `inbound.service.spec.ts` — 25 passed.
- [ ] `src/modules/mail src/modules/tickets` — 164 passed.
- [ ] `tsc --noEmit` и `eslint` — без ошибок.
- [ ] `{ uid: true }` — третий аргумент `fetch()`.
- [ ] Bootstrap-ветка делает `return` до обработки истории.
- [ ] Watermark не сдвигается за необработанное письмо (кроме явного карантина).
- [ ] Mask-путь создаёт новый тикет только на `NotFoundException`.
