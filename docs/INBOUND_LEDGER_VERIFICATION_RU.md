# Проверка production-ready inbound mail → ticket

Этот документ описывает проверку текущей схемы `InboundDelivery` перед merge и
production cutover. Он намеренно не привязан к старой ветке, SHA или числу тестов:
проверяется именно код, который будет развёрнут.

## Инварианты

- IMAP cursor продвигается только после durable acceptance и не перепрыгивает failure.
- Старый poller не может принять delivery или сдвинуть cursor после reconcile, смены
  mailbox identity или UIDVALIDITY.
- Повтор одного transport delivery не создаёт второй ticket/post.
- Две независимые headerless IMAP доставки не склеиваются только из-за одинаковых байтов.
- Настоящий одинаковый Message-ID с одинаковой semantic content даёт один logical ticket;
  semantic conflict остаётся в ledger/quarantine и поднимает alert.
- PIPE принимает body только после проверки секрета, только в enabled `PIPE` queue и только с
  ограниченным `x-inbound-delivery-id`; transport key использует его SHA-256.
- Truncated MIME нельзя replay без безопасного original-message refetch.
- Операторское действие имеет permission, reason и durable audit; raw MIME/credentials не
  выдаются через API/UI.

## Локальные автоматические gates

В чистом worktree, из корня монорепо:

```bash
node --version                         # 22+
npm ci
cd apps/api
npx prisma generate
npx prisma validate
npx vitest run src/modules/mail src/modules/tickets src/auth --reporter=dot
npx tsc --noEmit
npx eslint "src/**/*.ts" --max-warnings=0

cd ../web
npx tsc --noEmit
npx eslint . --max-warnings=0
npx vitest run --reporter=dot
```

Проверить также:

```bash
cd /path/to/repository
git diff --check
git status --short
git diff --name-only -z BASE..HEAD | \
  xargs -0 -r perl -0777 -ne 'if (index($_, "\0") >= 0) { print "$ARGV\n"; $bad=1 } END { exit($bad ? 1 : 0) }'
```

`BASE` — фактический merge-base review branch и `main`. Нельзя заменить чистую установку
старыми `node_modules`; lockfile должен быть единственным источником версий.

## Что проверяют unit/HTTP тесты

### IMAP acceptance и fencing

- mailbox epoch входит в IMAP transport key; смена identity повышает epoch даже при
  `uidValidity = NULL`; password-only update epoch не меняет;
- collision старого и нового mailbox UID-space с разным content hash halt-ит очередь и не
  сдвигает cursor;
- cursor CAS включает fixed snapshot (`generation`, `epoch`, `uidValidity`, `syncState`,
  исходный cursor);
- barrier `fetch → identity/reconcile → insert` доказывает, что stale poller не создаёт
  delivery/ticket;
- lower UID failure удерживает safe frontier, даже если higher UID уже принят;
- `FROM_NOW` фиксирует `UIDNEXT - 1` под mailbox lock до HTTP success; `BACKFILL` берёт
  последние N реально существующих UID, а не арифметический диапазон.

### Logical identity и routing

- `InboundMessageClaim` — отдельный atomic claim для нормализованного настоящего Message-ID;
  delivery хранит observed ID, raw content hash и semantic hash;
- same Message-ID + same semantic content → loser `SKIPPED`; same Message-ID + different
  semantic content → loser `QUARANTINED`, audit/critical alert;
- headerless IMAP identity строится из transport identity; одинаковые bytes под разными UID
  создают отдельные tickets;
- PIPE всегда требует MTA delivery id; его trusted queue address snapshot хранится как
  `envelopeTo` для BCC/deterministic routing;
- routing owner выбирается по enabled queue address, `routingPriority` (меньше лучше) и queue id;
  persisted route не зависит от arrival order двух poller.

### PIPE HTTP pipeline

- middleware проверяет `x-inbound-secret` до route-specific large parser;
- `message/rfc822` и `application/octet-stream` доходят byte-exact `Buffer`;
- JSON `{ raw }` не перехватывается глобальным parser;
- missing/unsafe/over-256-byte delivery id, missing queue id, disabled queue или IMAP/POP3 queue
  возвращают 4xx до ticket work;
- body больше `TELECOM_HD_INBOUND_MAX_SIZE_MB` получает 413;
- reused delivery id с другим content hash возвращает 409 и пишет `mail.transport_collision`;
- BigInt в queue/health response сериализуется строкой.

### Supervisor и health

- concurrent timer/manual `pollNow()` делят один poll cycle; один queue не poll-ится параллельно;
- drain ticks также single-flight, shutdown ждёт уже начатый poll/drain перед logout;
- even with `TELECOM_HD_IMAP_ENABLED=false` обновляется `ownAddresses` для PIPE self-loop guard;
- health возвращает attempt/connect/disconnect/error/poll started/poll completed/accepted,
  backlog, quarantine count+bytes, raw-storage reserve и alerts;
- disabled queues не создают critical alert; enabled IMAP + global disable, stale connection/poll,
  BOOTSTRAPPING, halted queue, backlog, lease, quarantine и recent collision видимы оператору.

### Quarantine, raw storage и RBAC

- list quarantine server-paginated, filterable и не возвращает `rawMime` или `rawStorageKey`;
  detail содержит metadata, capability replay и audit history;
- replay требует reason + `expectedUpdatedAt`, использует state/version CAS, а audit insert живёт
  в той же transaction; concurrency loser получает 409;
- large raw MIME хранится в existing uploads volume под opaque key; write = pending marker →
  temp file/fsync → atomic rename → ledger pointer → marker commit. Bounded reaper удаляет только
  stale unreferenced marker/file pairs. Quarantined MIME retention job не удаляет;
- storage reserve проверяется fail-closed для oversized ingress; ответ пользователю не раскрывает
  filesystem path;
- `mail.view`, `mail.replay`, `mail.reconcile`, `mail.configure` проверяются backend guard-ом.
  Upgrade переносит старый `admin.mail` в все четыре права; Manager получает только `mail.view`,
  Agent — ни одного mail permission.

## Anti-false-green мутации

Вносить временно, убедиться в RED, затем полностью откатить и повторить GREEN:

1. Убрать epoch из IMAP transport key → test same UIDVALIDITY/UID after identity change падает.
2. Убрать generation/epoch/state из accept/cursor CAS → stale-poller barrier падает.
3. Сделать `FROM_NOW` success до UIDNEXT snapshot/write → post-boundary test падает.
4. Синтезировать headerless identity из `queueId + contentHash` → two same-bytes different-UID test
   падает.
5. При semantic conflict вернуть `SKIPPED` → conflict quarantine/audit test падает.
6. Разрешить PIPE без queue/delivery id или убрать secret middleware → HTTP binding/early-secret
   test падает.
7. Снять `truncated` guard при replay → truncated replay test падает.
8. Убрать poll/drain single-flight flag → overlapping timer test падает.
9. Записать replay state вне transaction/audit → transaction mock, разделяющий root Prisma и `tx`,
   падает.
10. Удалить raw pending marker/DB reference proof → orphan cleanup test падает.

## Обязательные реальные gates до production cutover

Unit mocks не заменяют PostgreSQL и IMAP. Красный или не проведённый gate блокирует merge/deploy.

### Disposable PostgreSQL

1. Применить все migrations через `prisma migrate deploy` на production-like fixture.
2. Проверить `prisma migrate diff`, schema/migration parity, BigInt UID > 2³¹ и counts legacy rows.
3. Проверить permission backfill: custom `admin.mail` group → 4 new permissions; Manager → view;
   Agent/custom group without legacy right → no write rights.
4. Проверить interrupted migration/roll-forward, mailbox epoch rewrite/claim backfill и backup+restore
   PostgreSQL + uploads/raw MIME + Redis recovery triplet.
5. Поднять два API process: concurrent reconcile, stale acceptance fence, Message-ID claim and slow
   lease processing must have one correct durable outcome.

### GreenMail/Dovecot

Run via `InboundMailService.pollNow()` against a disposable real mailbox:

- fresh FROM_NOW and first UID after exact boundary;
- sparse UID BACKFILL + EXPUNGE;
- reconnect, DB outage during acceptance, restart and stale lease reclaim;
- UIDVALIDITY reset and different mailbox with same UIDVALIDITY/UID after identity change;
- two identical headerless messages under different UIDs;
- same Message-ID CC'd to two queues in opposite arrival order;
- spoofed same Message-ID with different semantic content;
- oversized/truncated fetch and refused replay;
- PIPE retry/collision and PIPE ↔ IMAP logical-copy behaviour.

For each scenario record ledger states, ticket/post count, cursor/generation/epoch, audit rows and
`GET /api/admin/email-queues/inbound/health` alerts.

## Cutover and rollback rule

Before deploy: quiesce inbound workers, drain/record outstanding deliveries, take and verify a
matching PostgreSQL + uploads/raw storage + Redis backup, run migrations, deploy one canary queue,
then enable remaining queues only after the live matrix is green. Schema changes are forward-only:
application-code rollback may be possible, but data rollback may require roll-forward rather than
running an old binary against the new schema. Do not delete ledger/raw evidence as a rollback step.
