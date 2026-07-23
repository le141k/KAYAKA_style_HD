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
- Capture-only queue получает необратимый `captureRetiredAt` до IMAP login/fetch; после попытки
  capture она не может стать normal ingress и для следующего теста нужна новая queue+папка.
- Большой raw MIME получает queue-bound stage `ACTIVE` до записи файла. Marker и deterministic
  private temp `inbound-raw/.staging/<UUID>.tmp` fsync-ятся до publish; путь derived из opaque key,
  а не случайное неотслеживаемое имя. Непосредственно перед atomic rename writer берёт короткий publish-fence
  lock только на `ACTIVE`. Если reaper уже durable перевёл row в `REAPING`, writer abort-ится до
  publish; если writer выиграл lock, он делает rename и renew lease под тем же lock. Затем
  acceptance lock-ит только `ACTIVE` и atomically пишет ledger pointer + `COMMITTED`. Marker commit
  и удаление `COMMITTED` stage происходят после commit; `REAPING` сначала durable фиксируется до
  destructive filesystem unlink (и destination, и deterministic temp). Rollback после publish
  сохраняет marker+destination для durable stage/reaper recovery. Capture arm делает bounded sweep и
  fail-closed, пока reservation
  той же queue остаётся.
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
# Disposable PostgreSQL + Redis + real GreenMail SMTP/IMAP socket: FROM_NOW boundary → next UID
npx vitest run --config vitest.integration.config.ts src/modules/mail/inbound.imap.int-spec.ts --reporter=dot
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
- Normal IMAP/PIPE acceptance, cursor CAS и normal drain/claim имеют противоположный
  `captureRetiredAt` fence; capture path требует marker. Первый terminal capture disable-ит
  очередь в той же транзакции, а DB guard не даёт очистить marker, re-enable disabled queue или
  удалить её.

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
  detail содержит безопасную timeline actor/action/reason, capability replay и audit history,
  но не opaque audit metadata;
- replay требует reason + `expectedUpdatedAt`, использует state/version CAS, а audit insert живёт
  в той же transaction; concurrency loser получает 409;
- large raw MIME хранится в existing uploads volume под opaque key; write = `ACTIVE` stage →
  durable pending marker + deterministic private temp `inbound-raw/.staging/<UUID>.tmp`/fsync →
  короткий DB publish fence (`SELECT ...
ACTIVE FOR UPDATE`) → atomic rename + lease refresh под lock → ledger pointer + `COMMITTED` в
  одной DB transaction → post-commit marker commit → delete `COMMITTED` stage. Если reaper уже
  committed `REAPING`, writer не получает publish capability и не делает rename. Slow write и
  destructive cleanup не держат DB transaction; только короткий rename hand-off намеренно держит
  row lock. Failed/orphan cleanup сначала durable переводит `ACTIVE → REAPING`, затем вне DB
  transaction удаляет и destination, и deterministic temp, затем удаляет stage/marker. DB-first
  reaper сканирует expired `ACTIVE` и все
  `COMMITTED`/`REAPING` даже без marker; referenced `COMMITTED` file не удаляется. Quarantined MIME
  retention job не удаляет; rollback после publish не прячет marker/destination, а оставляет их для
  durable stage/reaper recovery;
- storage reserve проверяется fail-closed для oversized ingress; ответ пользователю не раскрывает
  filesystem path;
- `mail.view`, `mail.replay`, `mail.capture.promote`, `mail.reconcile`, `mail.configure`
  проверяются backend guard-ом. Любое изменяющее состояние почтовое действие требует
  **оба** права: `mail.view` и своё специальное право. Продвижение `CAPTURED` требует
  `mail.view` и `mail.capture.promote`; последнее отдельно от `mail.replay`, потому что может перевести
  тестовое письмо в обработку тикета и не выдаётся историческим custom-ролям
  автоматически. Upgrade переносит старый `admin.mail` только в четыре прежних права; Manager
  получает только `mail.view`, Agent — ни одного mail permission.

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
10. Разрешить acceptance не-`ACTIVE` stage или убрать atomic `COMMITTED` вместе с ledger pointer →
    state-machine acceptance test падает.
11. Выполнить filesystem unlink до committed `REAPING` или разрешить `REAPING` acceptance →
    rollback-after-unlink regression падает.
12. Убрать DB-first scan `ACTIVE`/`COMMITTED`/`REAPING` без pending marker →
    crash-after-reservation-without-marker test падает.
13. Убрать queue-bound stage или проверку stage после bounded arm sweep → regression на
    «reservation remains → arm refuses before IMAP auth/fetch» падает.
14. Убрать `ACTIVE` publish-fence lock перед final rename или разрешить publish после durable
    `REAPING` → writer-vs-reaper barrier test (temp fsync → race → publish) падает: winner либо
    abort-ит writer до rename, либо writer renew-ит lease под lock.
15. Сгенерировать случайный невыводимый из `storageKey` temp path или изменить `removeFile`, чтобы
    он удалял только destination → crash-after-temp-fsync regression падает: durable `REAPING`
    reaper обязан убрать `inbound-raw/.staging/<UUID>.tmp` до удаления stage/marker.
16. В `FROM_NOW` записать cursor до `UIDNEXT - 1` → live GreenMail integration gate падает:
    historical UID ошибочно создаёт вторую delivery/post вместо ровно одной следующей UID.

## Обязательные реальные gates до production cutover

Unit mocks не заменяют PostgreSQL и IMAP. Красный или не проведённый gate блокирует merge/deploy.

### Disposable PostgreSQL

1. Применить все migrations через `prisma migrate deploy` на production-like fixture.
2. Проверить `prisma migrate diff`, schema/migration parity, BigInt UID > 2³¹ и counts legacy rows.
3. Проверить permission backfill: custom `admin.mail` group → 4 new permissions; Manager → view;
   Agent/custom group without legacy right → no write rights.
4. Проверить interrupted migration/roll-forward, mailbox epoch rewrite/claim backfill и backup+restore
   PostgreSQL + uploads/raw MIME + Redis recovery triplet. Отдельно прогнать upgrade
   `20260723063000 → 20260723064000`: CAPTURED/promoted queue получает marker+disable, обычный
   truncated `QUARANTINED` не маркируется, index/DB triggers на месте и marker нельзя снять.
   Затем `20260723064000 → 20260723066000`: nullable staging `queueId`, FK/index, stage-bound
   `ACTIVE`/`COMMITTED`/`REAPING`, queue/state indexes, state-machine acceptance, rollback-after-
   unlink и DB-first reaper без guessed owner для legacy `queueId=NULL`. Отдельный two-process
   barrier: после fsync private temp одновременно запустить reaper и writer publish; `REAPING`
   обязан запретить rename, а writer-winner обязан atomically rename+renew lease под `ACTIVE` lock.
   Отдельно crash после fsync до publish: reaper удаляет deterministic
   `inbound-raw/.staging/<UUID>.tmp` и (если есть) destination до release stage/marker.
   `20260723066000` также добавляет lookup index по `InboundDelivery.rawStorageKey`, чтобы
   pointer verification reaper-а не сканировал terminal ledger под staging fence.
5. Поднять два API process: concurrent reconcile, stale acceptance fence, Message-ID claim and slow
   lease processing must have one correct durable outcome.

### GreenMail/Dovecot

Run via `InboundMailService.pollNow()` against a disposable real mailbox:

Автоматический локальный минимум уже закреплён в
`src/modules/mail/inbound.imap.int-spec.ts`: Testcontainers поднимает disposable PostgreSQL, Redis и
`greenmail/standalone:2.1.11`, кладёт одно historical письмо до startup, проверяет synchronous
`FROM_NOW` boundary, затем доставляет следующее письмо через реальный SMTP и вызывает реальный
`pollNow()`. Ожидается ровно одна `PROCESSED` delivery, один ticket post и cursor на новом UID.
Это регрессия для базового transport path, но не замена полной нижеследующей матрицы (TLS capture,
UIDVALIDITY reset, EXPUNGE, restart и two-process races по-прежнему должны быть пройдены отдельно).

- fresh FROM_NOW and first UID after exact boundary;
- sparse UID BACKFILL + EXPUNGE;
- reconnect, DB outage during acceptance, restart and stale lease reclaim;
- UIDVALIDITY reset and different mailbox with same UIDVALIDITY/UID after identity change;
- two identical headerless messages under different UIDs;
- same Message-ID CC'd to two queues in opposite arrival order;
- spoofed same Message-ID with different semantic content;
- oversized/truncated fetch and refused replay;
- PIPE retry/collision and PIPE ↔ IMAP logical-copy behaviour.
- capture-only arm до IMAP authentication, один terminal capture, auto-disable/retirement и отказ
  fresh IMAP/PIPE/reconcile на той же queue; повторный test только с новой queue+folder.
- large IMAP/PIPE raw staging: `ACTIVE` reservation → pending marker + deterministic private
  temp `inbound-raw/.staging/<UUID>.tmp`/fsync →
  publish-fence `ACTIVE` lock → atomic rename+lease refresh → ledger pointer + `COMMITTED`
  atomically → marker/stage finalizer. Проверить `REAPING` before unlink, crash after reservation
  before marker, crash/rollback after rename, referenced `COMMITTED` file retention, DB-first reaper
  и отказ capture arm после bounded sweep, пока queue-bound stage остаётся, до IMAP auth/fetch.
  Crash после temp fsync до publish обязан закончиться удалением этого deterministic temp тем же
  durable `REAPING` reaper path.
  Отдельно воспроизвести race reaper vs writer между temp fsync и final rename: `REAPING` winner не
  публикует final file; writer winner публикует только под stage lock и renew-ит lease.

For each scenario record ledger states, ticket/post count, cursor/generation/epoch, audit rows and
`GET /api/admin/email-queues/inbound/health` alerts.

## Cutover and rollback rule

Before deploy: quiesce **all old** inbound workers before arming capture-only, drain/record outstanding deliveries, take and verify a
matching PostgreSQL + uploads/raw storage + Redis backup, run migrations, deploy one canary queue,
then enable remaining queues only after the live matrix is green. Schema changes are forward-only:
application-code rollback may be possible, but data rollback may require roll-forward rather than
running an old binary against the new schema. Do not delete ledger/raw evidence as a rollback step.
