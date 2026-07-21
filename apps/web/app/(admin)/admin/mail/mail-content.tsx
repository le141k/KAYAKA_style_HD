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
  useReconcileQueue,
  useReplayQuarantined,
  type AdminEmailQueue,
  type EmailQueueSyncState,
  type QuarantinedDelivery,
  type ReconcileMode,
} from '@/lib/hooks/use-mail';

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

export function MailContent() {
  const queues = useEmailQueues();
  const health = useInboundHealth();
  const quarantine = useQuarantine();
  const reconcile = useReconcileQueue();
  const replay = useReplayQuarantined();

  const [reconcileFor, setReconcileFor] = useState<AdminEmailQueue | null>(null);
  const [detailFor, setDetailFor] = useState<QuarantinedDelivery | null>(null);
  const [mode, setMode] = useState<ReconcileMode>('RESUME_MIGRATED');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [backfillLimit, setBackfillLimit] = useState<number>(100);

  function openReconcile(q: AdminEmailQueue) {
    setReconcileFor(q);
    setMode('RESUME_MIGRATED');
    setReason('');
    setConfirm(false);
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

  function doReplay(id: number) {
    replay.mutate(id, {
      onSuccess: () => toast({ title: 'Возвращено в обработку', description: `Delivery #${id}` }),
      onError: () => toast({ title: 'Не удалось переотправить', variant: 'destructive' }),
    });
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: 'Бэклог', value: h?.ledger.backlog ?? 0 },
                { label: 'В обработке', value: h?.ledger.byState.processing ?? 0 },
                { label: 'Повтор', value: h?.ledger.byState.retry ?? 0 },
                { label: 'Карантин', value: h?.ledger.byState.quarantined ?? 0 },
                { label: 'Обработано', value: h?.ledger.byState.processed ?? 0 },
                { label: 'Пропущено', value: h?.ledger.byState.skipped ?? 0 },
              ].map((s) => (
                <div key={s.label} className="rounded-xl border border-border bg-card p-3">
                  <div className="text-2xl font-bold tabular-nums">{s.value}</div>
                  <div className="text-xs text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
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
                  <TableHead>Ген.</TableHead>
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
                    <TableCell className="tabular-nums">{q.cursorGeneration}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {q.lastAcceptedAt ? (
                        <>
                          принято <RelativeTime date={q.lastAcceptedAt} />
                        </>
                      ) : q.lastPollAt ? (
                        <>
                          опрос <RelativeTime date={q.lastPollAt} />
                        </>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {q.type === 'IMAP' && (
                        <Button variant="outline" size="sm" onClick={() => openReconcile(q)}>
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
          Карантин {quarantine.data ? `(${quarantine.data.length})` : ''}
        </h2>
        {quarantine.isError ? (
          <QueryError onRetry={() => void quarantine.refetch()} />
        ) : (
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
                {(quarantine.data ?? []).map((d) => (
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
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={replay.isPending}
                        onClick={() => doReplay(d.id)}
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" />
                        Переотправить
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {(quarantine.data ?? []).length === 0 && !quarantine.isLoading && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                      Карантин пуст.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
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
              <label className="text-sm font-medium">Режим</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={mode}
                onChange={(e) => setMode(e.target.value as ReconcileMode)}
              >
                <option value="RESUME_MIGRATED">RESUME_MIGRATED — перенести устаревший курсор</option>
                <option value="FROM_NOW">FROM_NOW — начать с текущего момента</option>
                <option value="BACKFILL">BACKFILL — добрать последние N писем</option>
              </select>
              <p className="text-xs text-muted-foreground">
                {mode === 'RESUME_MIGRATED' &&
                  'Переносит устаревший Setting-курсор (UIDVALIDITY + watermark) на ledger.'}
                {mode === 'FROM_NOW' &&
                  'Отбрасывает курсор и стартует с текущего high-water — может пропустить письма, пришедшие необработанными.'}
                {mode === 'BACKFILL' && 'Пере-бутстрап с добором последних N существующих писем.'}
              </p>
            </div>

            {mode === 'BACKFILL' && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Сколько писем добрать</label>
                <Input
                  type="number"
                  min={1}
                  value={backfillLimit}
                  onChange={(e) => setBackfillLimit(Number(e.target.value))}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Причина {mode === 'FROM_NOW' && <span className="text-destructive">*</span>}
              </label>
              <Textarea
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
                (mode === 'BACKFILL' && backfillLimit < 1)
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
          {detailFor && (
            <dl className="space-y-2 text-sm">
              {[
                ['Транспорт', detailFor.transport],
                ['Очередь', detailFor.queueId ?? '—'],
                ['Message-ID', detailFor.messageId ?? '—'],
                ['От', detailFor.envelopeFrom ?? '—'],
                ['Кому', detailFor.envelopeTo ?? '—'],
                ['Тема', detailFor.subject || '(без темы)'],
                ['Размер', `${detailFor.sizeBytes} байт`],
                ['Попыток', detailFor.attempts],
              ].map(([k, v]) => (
                <div key={String(k)} className="grid grid-cols-3 gap-2">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="col-span-2 break-words">{v}</dd>
                </div>
              ))}
              <div className="grid grid-cols-3 gap-2">
                <dt className="text-muted-foreground">Ошибка</dt>
                <dd className="col-span-2 break-words text-destructive">{detailFor.lastError ?? '—'}</dd>
              </div>
            </dl>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDetailFor(null)}>
              Закрыть
            </Button>
            {detailFor && (
              <Button
                variant="outline"
                disabled={replay.isPending}
                onClick={() => {
                  doReplay(detailFor.id);
                  setDetailFor(null);
                }}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Переотправить
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
