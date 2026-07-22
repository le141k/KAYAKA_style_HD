'use client';

import { useState } from 'react';
import { AlertTriangle, Mail, RefreshCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { RelativeTime } from '@/components/RelativeTime';
import { QueryError } from '@/components/QueryError';
import {
  useEmailQueues,
  useInboundHealth,
  useQuarantine,
  useQuarantineDetail,
  useReconcileQueue,
  useReplayQuarantined,
  type AdminEmailQueue,
  type EmailQueueSyncState,
  type QuarantinedDelivery,
  type ReconcileMode,
} from '@/lib/hooks/use-mail';
import { useMe } from '@/lib/hooks/use-auth';
import { hasPermission, PERMISSIONS } from '@/lib/auth/permissions';

function syncStateBadge(state: EmailQueueSyncState) {
  switch (state) {
    case 'OK':
      return <Badge variant="secondary">OK</Badge>;
    case 'BOOTSTRAPPING':
      return <Badge variant="outline">BOOTSTRAPPING</Badge>;
    case 'NEEDS_RECONCILIATION':
      return <Badge variant="destructive">NEEDS RECONCILIATION</Badge>;
    default:
      return <Badge variant="ghost">{state}</Badge>;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Health returns filesystem counters as strings so a BigInt never crosses JSON. */
function formatStoredBytes(value: string): string {
  try {
    const bytes = BigInt(value);
    if (bytes < 1024n) return `${bytes} B`;
    if (bytes < 1024n * 1024n) return `${bytes / 1024n} KiB`;
    if (bytes < 1024n * 1024n * 1024n) return `${bytes / (1024n * 1024n)} MiB`;
    return `${bytes / (1024n * 1024n * 1024n)} GiB`;
  } catch {
    return '—';
  }
}

export function MailContent() {
  const queues = useEmailQueues();
  const health = useInboundHealth();
  const [quarantinePage, setQuarantinePage] = useState(1);
  const [quarantineQueueId, setQuarantineQueueId] = useState('');
  const [quarantineReason, setQuarantineReason] = useState('');
  const [quarantineMessageId, setQuarantineMessageId] = useState('');
  const quarantine = useQuarantine({
    page: quarantinePage,
    queueId: /^\d+$/.test(quarantineQueueId) ? Number(quarantineQueueId) : undefined,
    reason: quarantineReason || undefined,
    messageId: quarantineMessageId || undefined,
  });
  const reconcile = useReconcileQueue();
  const replay = useReplayQuarantined();
  const { data: me } = useMe();

  const [reconcileFor, setReconcileFor] = useState<AdminEmailQueue | null>(null);
  const [detailFor, setDetailFor] = useState<QuarantinedDelivery | null>(null);
  const detail = useQuarantineDetail(detailFor?.id ?? null);
  const [replayFor, setReplayFor] = useState<QuarantinedDelivery | null>(null);
  const [replayReason, setReplayReason] = useState('');
  const [mode, setMode] = useState<ReconcileMode>('RESUME_MIGRATED');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [backfillLimit, setBackfillLimit] = useState<number>(100);
  const canReconcile = hasPermission(me, PERMISSIONS.MAIL_RECONCILE);
  const canReplay = hasPermission(me, PERMISSIONS.MAIL_REPLAY);

  function openReconcile(q: AdminEmailQueue) {
    // The server is the sole authority for allowed reconciliation modes. Never recreate a
    // permissive client-side fallback: a stale UI must fail closed and refresh instead.
    if (!q.allowedModes?.length) {
      toast({
        title: 'Нужны свежие данные очереди',
        description: 'Сервер не вернул допустимые режимы реконсиляции. Обновите страницу.',
        variant: 'destructive',
      });
      return;
    }
    setReconcileFor(q);
    setMode(q.allowedModes[0]!);
    setReason('');
    setConfirm(false);
    setConfirmationText('');
    setBackfillLimit(100);
  }

  function submitReconcile() {
    if (!reconcileFor) return;
    reconcile.mutate(
      {
        id: reconcileFor.id,
        mode,
        reason: reason.trim() || undefined,
        confirm: mode === 'FROM_NOW' ? confirm : undefined,
        backfillLimit: mode === 'BACKFILL' ? backfillLimit : undefined,
        expectedCursorGeneration: reconcileFor.cursorGeneration,
      },
      {
        onSuccess: () => {
          toast({ title: 'Очередь реконсилирована', description: `Режим: ${mode}` });
          setReconcileFor(null);
        },
        onError: (err: unknown) => {
          const msg =
            err && typeof err === 'object' && 'data' in err
              ? String((err as { data?: { message?: unknown } }).data?.message ?? 'Ошибка')
              : 'Ошибка';
          toast({ title: 'Не удалось реконсилировать', description: msg, variant: 'destructive' });
        },
      },
    );
  }

  function submitReplay() {
    if (!replayFor) return;
    replay.mutate(
      {
        deliveryId: replayFor.id,
        reason: replayReason.trim(),
        expectedUpdatedAt: replayFor.updatedAt,
      },
      {
        onSuccess: () => {
          toast({ title: 'Возвращено в обработку', description: `Delivery #${replayFor.id}` });
          setReplayFor(null);
          setReplayReason('');
        },
        onError: () => toast({ title: 'Не удалось переотправить', variant: 'destructive' }),
      },
    );
  }

  const h = health.data;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Mail className="h-6 w-6" />
            Почтовые очереди
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Входящая почта → заявки: состояние синхронизации, здоровье, карантин.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void queues.refetch();
            void health.refetch();
            void quarantine.refetch();
          }}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Обновить
        </Button>
      </div>

      {/* ── Health summary + alerts ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Здоровье конвейера</h2>
        {health.isError ? (
          <QueryError onRetry={() => void health.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
              {[
                { label: 'Бэклог', value: h ? h.ledger.backlog : '—' },
                { label: 'В обработке', value: h ? h.ledger.byState.processing : '—' },
                { label: 'Повтор', value: h ? h.ledger.byState.retry : '—' },
                { label: 'Карантин', value: h ? h.ledger.byState.quarantined : '—' },
                { label: 'Карантин, объём', value: h ? formatBytes(h.ledger.quarantineBytes) : '—' },
                { label: 'Обработано', value: h ? h.ledger.byState.processed : '—' },
                { label: 'Пропущено', value: h ? h.ledger.byState.skipped : '—' },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-border bg-card p-3">
                  <div className="text-2xl font-bold tabular-nums">{s.value}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
            {h?.rawStorage && (
              <p className="text-xs text-muted-foreground">
                Raw MIME storage: свободно {formatStoredBytes(h.rawStorage.availableBytes)}, резерв{' '}
                {formatStoredBytes(h.rawStorage.reserveBytes)}
                {h.rawStorage.nearReserve ? ' — близко к резерву.' : '.'}
              </p>
            )}
            {h && h.alerts.length > 0 && (
              <div className="space-y-2">
                {h.alerts.map((a, i) => (
                  <div
                    key={`${a.kind}-${i}`}
                    className={
                      'flex items-start gap-2 rounded-lg border p-3 text-sm ' +
                      (a.severity === 'critical'
                        ? 'border-destructive/40 bg-destructive/5 text-destructive'
                        : 'border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400')
                    }
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <span>{a.message}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* ── Queues ──────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Очереди</h2>
        {queues.isError ? (
          <QueryError onRetry={() => void queues.refetch()} />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Адрес</TableHead>
                  <TableHead>Тип</TableHead>
                  <TableHead>Состояние</TableHead>
                  <TableHead>Курсор (UID / UIDVALIDITY)</TableHead>
                  <TableHead>Epoch / ген.</TableHead>
                  <TableHead>Активность</TableHead>
                  <TableHead className="text-right">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(queues.data ?? []).map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="font-medium">
                      {q.emailAddress}
                      {!q.isEnabled && (
                        <Badge variant="ghost" className="ml-2">
                          выкл
                        </Badge>
                      )}
                      {q.lastError && (
                        <div className="mt-1 max-w-xs truncate text-xs text-destructive" title={q.lastError}>
                          {q.lastError}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{q.type}</TableCell>
                    <TableCell>{syncStateBadge(q.syncState)}</TableCell>
                    <TableCell className="tabular-nums text-xs">
                      {q.lastSeenUid} / {q.uidValidity ?? '—'}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {q.mailboxEpoch ?? '—'} / {q.cursorGeneration}
                      {q.reconcileCause && (
                        <div className="text-xs text-muted-foreground">{q.reconcileCause}</div>
                      )}
                      {q.routingPriority !== undefined && (
                        <div className="text-xs text-muted-foreground">prio {q.routingPriority}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <div>
                        подключение: {q.lastConnectedAt ? <RelativeTime date={q.lastConnectedAt} /> : '—'}
                      </div>
                      <div>
                        опрос:{' '}
                        {q.lastPollStartedAt &&
                        (!q.lastPollCompletedAt || q.lastPollStartedAt > q.lastPollCompletedAt) ? (
                          <>
                            выполняется с <RelativeTime date={q.lastPollStartedAt} />
                          </>
                        ) : q.lastPollCompletedAt ? (
                          <>
                            завершён <RelativeTime date={q.lastPollCompletedAt} />
                          </>
                        ) : (
                          '—'
                        )}
                      </div>
                      <div>принято: {q.lastAcceptedAt ? <RelativeTime date={q.lastAcceptedAt} /> : '—'}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      {q.type === 'IMAP' && canReconcile && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!q.allowedModes?.length || reconcile.isPending}
                          onClick={() => openReconcile(q)}
                        >
                          Реконсиляция
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
                {(queues.data ?? []).length === 0 && !queues.isLoading && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                      Очереди не настроены.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* ── Quarantine ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Карантин {quarantine.data ? `(${quarantine.data.total})` : ''}
        </h2>
        {quarantine.isError ? (
          <QueryError onRetry={() => void quarantine.refetch()} />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input
                aria-label="Фильтр карантина по очереди"
                className="max-w-44"
                inputMode="numeric"
                placeholder="Queue ID"
                value={quarantineQueueId}
                onChange={(e) => {
                  setQuarantineQueueId(e.target.value);
                  setQuarantinePage(1);
                }}
              />
              <Input
                aria-label="Фильтр карантина по причине"
                className="max-w-56"
                placeholder="Причина"
                value={quarantineReason}
                onChange={(e) => {
                  setQuarantineReason(e.target.value);
                  setQuarantinePage(1);
                }}
              />
              <Input
                aria-label="Фильтр карантина по Message-ID"
                className="max-w-64"
                placeholder="Message-ID"
                value={quarantineMessageId}
                onChange={(e) => {
                  setQuarantineMessageId(e.target.value);
                  setQuarantinePage(1);
                }}
              />
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Транспорт</TableHead>
                    <TableHead>От</TableHead>
                    <TableHead>Тема</TableHead>
                    <TableHead>Попыток</TableHead>
                    <TableHead>Когда</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(quarantine.data?.items ?? []).map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="tabular-nums">{d.id}</TableCell>
                      <TableCell className="text-muted-foreground">{d.transport}</TableCell>
                      <TableCell className="max-w-[12rem] truncate">{d.envelopeFrom ?? '—'}</TableCell>
                      <TableCell className="max-w-[16rem] truncate">{d.subject || '(без темы)'}</TableCell>
                      <TableCell className="tabular-nums">{d.attempts}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <RelativeTime date={d.createdAt} />
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setDetailFor(d)}>
                          Детали
                        </Button>
                        {canReplay && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={replay.isPending || !d.replayAllowed}
                            title={
                              !d.replayAllowed
                                ? 'Неполное письмо нельзя переотправить без безопасного refetch'
                                : undefined
                            }
                            onClick={() => {
                              setReplayFor(d);
                              setReplayReason('');
                            }}
                          >
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            Переотправить
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(quarantine.data?.items ?? []).length === 0 && !quarantine.isLoading && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                        Карантин пуст.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {quarantine.data && (
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Страница {quarantine.data.page} из{' '}
                  {Math.max(1, Math.ceil(quarantine.data.total / quarantine.data.limit))}
                </span>
                <div className="space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={quarantine.data.page <= 1}
                    onClick={() => setQuarantinePage((page) => Math.max(1, page - 1))}
                  >
                    Назад
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={quarantine.data.page * quarantine.data.limit >= quarantine.data.total}
                    onClick={() => setQuarantinePage((page) => page + 1)}
                  >
                    Дальше
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* ── Reconcile dialog ────────────────────────────────────────────────── */}
      <Dialog open={reconcileFor !== null} onOpenChange={(o) => !o && setReconcileFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Реконсиляция: {reconcileFor?.emailAddress}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="mail-reconcile-mode">
                Режим
              </label>
              <select
                id="mail-reconcile-mode"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={mode}
                onChange={(e) => setMode(e.target.value as ReconcileMode)}
              >
                {(reconcileFor?.allowedModes ?? []).map((allowedMode) => (
                  <option key={allowedMode} value={allowedMode}>
                    {allowedMode === 'RESUME_MIGRATED' && 'RESUME_MIGRATED — перенести устаревший курсор'}
                    {allowedMode === 'FROM_NOW' && 'FROM_NOW — начать с текущего момента'}
                    {allowedMode === 'BACKFILL' && 'BACKFILL — добрать последние N писем'}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {mode === 'RESUME_MIGRATED' &&
                  'Переносит устаревший Setting-курсор (UIDVALIDITY + watermark) на ledger.'}
                {mode === 'FROM_NOW' &&
                  'Отбрасывает курсор и стартует с текущего high-water — может пропустить письма, пришедшие необработанными.'}
                {mode === 'BACKFILL' &&
                  'Пере-бутстрап с добором последних N существующих писем. Headerless-письма при backfill могут видимо дублироваться — это безопаснее скрытой потери.'}
              </p>
            </div>

            {mode === 'BACKFILL' && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-reconcile-backfill-limit">
                  Сколько писем добрать
                </label>
                <Input
                  id="mail-reconcile-backfill-limit"
                  type="number"
                  min={1}
                  value={backfillLimit}
                  onChange={(e) => setBackfillLimit(Number(e.target.value))}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="mail-reconcile-reason">
                Причина{' '}
                {(mode === 'FROM_NOW' || mode === 'BACKFILL') && <span className="text-destructive">*</span>}
              </label>
              <Textarea
                id="mail-reconcile-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Для журнала аудита"
                rows={2}
              />
            </div>

            {mode === 'FROM_NOW' && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={confirm}
                  onChange={(e) => setConfirm(e.target.checked)}
                />
                <span>
                  Подтверждаю: FROM_NOW отбрасывает курсор и может пропустить необработанные письма.
                </span>
              </label>
            )}
            {(mode === 'FROM_NOW' || mode === 'BACKFILL') && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-reconcile-confirmation">
                  Введите CONFIRM для подтверждения
                </label>
                <Input
                  id="mail-reconcile-confirmation"
                  value={confirmationText}
                  onChange={(e) => setConfirmationText(e.target.value)}
                  autoComplete="off"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReconcileFor(null)}>
              Отмена
            </Button>
            <Button
              onClick={submitReconcile}
              disabled={
                reconcile.isPending ||
                (mode === 'FROM_NOW' && (!confirm || reason.trim().length === 0)) ||
                ((mode === 'FROM_NOW' || mode === 'BACKFILL') && confirmationText !== 'CONFIRM') ||
                (mode === 'BACKFILL' && (backfillLimit < 1 || reason.trim().length === 0))
              }
            >
              Выполнить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Quarantine detail dialog ────────────────────────────────────────── */}
      <Dialog open={detailFor !== null} onOpenChange={(o) => !o && setDetailFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delivery #{detailFor?.id}</DialogTitle>
          </DialogHeader>
          {detailFor && detail.data && (
            <dl className="space-y-2 text-sm">
              {[
                ['Транспорт', detail.data.delivery.transport],
                ['Очередь', detail.data.delivery.queueId ?? '—'],
                [
                  'Message-ID',
                  detail.data.delivery.observedMessageId ?? detail.data.delivery.messageId ?? '—',
                ],
                ['От', detail.data.delivery.envelopeFrom ?? '—'],
                ['Кому', detail.data.delivery.envelopeTo ?? '—'],
                ['Тема', detail.data.delivery.subject || '(без темы)'],
                ['Размер', `${detail.data.delivery.sizeBytes} байт`],
                ['Попыток', detail.data.delivery.attempts],
              ].map(([k, v]) => (
                <div key={String(k)} className="grid grid-cols-3 gap-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="col-span-2 break-words">{v}</dd>
                </div>
              ))}
              <div className="grid grid-cols-3 gap-2">
                <dt className="text-muted-foreground">Ошибка</dt>
                <dd className="col-span-2 break-words text-destructive">
                  {detail.data.delivery.lastError ?? '—'}
                </dd>
              </div>
              {!detail.data.delivery.replayAllowed && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-amber-700 dark:text-amber-300">
                  {detail.data.delivery.replayBlockReason ??
                    'Неполное письмо нельзя вернуть в обработку без безопасного повторного получения оригинала.'}
                </div>
              )}
              <div className="space-y-1 border-t pt-3">
                <dt className="font-medium">История действий</dt>
                {detail.data.audit.length === 0 ? (
                  <dd className="text-muted-foreground">Нет действий оператора.</dd>
                ) : (
                  detail.data.audit.map((entry) => (
                    <dd key={entry.id} className="text-xs text-muted-foreground">
                      <RelativeTime date={entry.createdAt} /> · {entry.action} ·{' '}
                      {entry.actorEmail || 'system'}
                      {entry.reason ? ` · ${entry.reason}` : ''}
                    </dd>
                  ))
                )}
              </div>
            </dl>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDetailFor(null)}>
              Закрыть
            </Button>
            {detailFor && canReplay && (
              <Button
                variant="outline"
                disabled={replay.isPending || !detail.data?.delivery.replayAllowed}
                onClick={() => {
                  setDetailFor(null);
                  if (detail.data?.delivery.replayAllowed) setReplayFor(detail.data.delivery);
                  setReplayReason('');
                }}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Переотправить
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Replay confirmation: reason + inspected row version are mandatory ── */}
      <Dialog open={replayFor !== null} onOpenChange={(o) => !o && setReplayFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Повторить delivery #{replayFor?.id}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Письмо вернётся в обработку. Укажите причину: она будет сохранена в аудите.
          </p>
          <Textarea
            id="mail-replay-reason"
            aria-label="Причина повтора карантинного письма"
            value={replayReason}
            onChange={(e) => setReplayReason(e.target.value)}
            placeholder="Что исправлено и почему повтор безопасен"
            rows={3}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setReplayFor(null)}>
              Отмена
            </Button>
            <Button disabled={replay.isPending || replayReason.trim().length === 0} onClick={submitReplay}>
              Подтвердить повтор
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
