# Durable outbound outbox — эксплуатационный runbook

## Что гарантирует этот срез

Публичный ответ сотрудника создаёт `TicketPost`, счётчики тикета, audit-запись и
одну `OutboundEmail` в **одной PostgreSQL-транзакции**. До приёма SMTP у post
всегда `isEmailed=false`, а в UI показывается состояние доставки, а не ложное
«отправлено».

`OutboundEmail.messageId` создаётся до commit и не меняется при retry. BullMQ
получает только `{ outboundEmailId }` с `jobId=mail:<outboxId>`; body,
адресаты и вложения в Redis не попадают. Если Redis недоступен, строка остаётся
в БД (`QUEUED`) и периодический startup/recovery scan добавит wake-up job после
восстановления Redis.

`Ticket.firstResponseAt` тоже фиксируется только в fenced transaction после
SMTP accept (и только если ещё `NULL`), поэтому SLA не считает неотправленный
черновик/очередь ответом.

## Состояния

| State        | Значение для оператора                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUED`     | Команда зафиксирована в БД, ждёт worker/Redis wake-up.                                                                                                        |
| `PROCESSING` | Worker владеет lease; heartbeat продлевает его во время SMTP. Истёкший lease становится `AMBIGUOUS`, а не поводом для автоматической повторной SMTP-отправки. |
| `SENT`       | SMTP transport вернул успешный accept; только теперь `isEmailed=true`.                                                                                        |
| `RETRY`      | Временный SMTP 4xx/локальный failure, следующая попытка назначена в `nextAttemptAt`.                                                                          |
| `FAILED`     | Постоянный SMTP 5xx либо исчерпан лимит повторов.                                                                                                             |
| `AMBIGUOUS`  | Timeout/reset мог произойти после SMTP DATA; автоматически не повторяется. Проверить relay и только затем вручную retry.                                      |

Каждое settlement обновляет строку по `leaseOwner + leaseVersion`. Потерявший
lease worker не может переписать состояние нового worker в `SENT`. Если worker
погиб или потерял связь с БД после начала SMTP, неизвестный результат остаётся
`AMBIGUOUS`; повтор возможен только после ручного решения оператора.

## Вложения и BCC

Для reply-вложений создаётся `OutboundEmailAttachment`: filename, MIME, size,
hash и storage key являются snapshot. `AttachmentsService` отказывает в прямом
удалении attachment, пока есть snapshot; DB cascade остаётся только для
согласованного удаления самого ticket/post/outbox. Так уже зафиксированное
исходящее письмо не теряет байты из-за действия менеджера. Лимит команды: не
более 10 файлов и 25 MiB суммарно.

Адресаты тоже snapshot-ятся. BCC передаётся SMTP только в envelope, но не
возвращается через ticket projection/API, не попадает в delivery badge и не
пишется в diagnostic/relay response.

## Операторские действия

- В staff ticket timeline видно `QUEUED`, `PROCESSING`, `SENT`, `RETRY`,
  `FAILED` или `AMBIGUOUS` возле public staff post.
- `POST /api/admin/outbound-emails/:id/retry` требует `admin.mail`. Допустимы
  только `FAILED`, `AMBIGUOUS`, `RETRY`; original `Message-ID`, content and
  recipients сохраняются. Попытка записывается как `OUTBOUND_RETRY` в ticket
  audit log.
- Для `AMBIGUOUS` сначала проверить SMTP relay по сохранённому Message-ID.
  Не объявлять письмо доставленным только по тому, что job завершился/Redis
  принял задачу.

## Ограничение этого среза

Транзакционный outbox покрывает **staff public ticket reply** — критичный
менеджерский путь. `sendTemplate()` для старых autoresponder/notification/SLA
веток пока остаётся legacy BullMQ path и не получает durable status/timeline.
`sendTemplateStrict()` для password-reset и magic-link сознательно остаётся
inline fail-closed: токены/URLs не сериализуются ни в outbox, ни в Redis.
Нельзя трактовать legacy template job как `SENT`; migration остальных system
mail command paths является отдельным срезом.

## Проверки перед cutover

1. Применить migration `20260723020000_durable_outbound_outbox` на
   production-like PostgreSQL вместе с остальными release migrations.
2. Создать staff reply с To, CC, BCC и attachment; убедиться, что Redis job
   содержит только id, BCC не виден в ticket API, а MIME содержит attachment.
3. Остановить Redis между DB commit и enqueue; после возврата Redis дождаться
   recovery scan и убедиться, что `QUEUED` был обработан.
4. Смоделировать SMTP 250, 421, 550 и timeout after DATA: ожидаются `SENT`,
   `RETRY`, `FAILED`, `AMBIGUOUS` соответственно. Проверить стабильный
   Message-ID в retry/manual retry.
5. Остановить worker после начала SMTP и дождаться истечения lease: строка
   должна перейти в `AMBIGUOUS`, без автоматической второй SMTP-попытки.
