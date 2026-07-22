'use client';

import { useState, type FormEvent } from 'react';
import { AlertTriangle, Mail, Pencil, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
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
  useCreateEmailQueue,
  useDeleteEmailQueue,
  useInboundHealth,
  useWorkflowEmailEventDetail,
  useWorkflowEmailEvents,
  useWorkflowEmailHealth,
  useQuarantine,
  useQuarantineDetail,
  useReconcileQueue,
  useReplayWorkflowEmailEvent,
  useReplayQuarantined,
  useUpdateEmailQueue,
  type AdminEmailQueue,
  type EmailQueueConfigInput,
  type EmailQueueSyncState,
  type QuarantinedDelivery,
  type ReconcileMode,
  type WorkflowEmailEventListItem,
  type WorkflowEmailEventState,
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

type QueueForm = {
  type: EmailQueueConfigInput['type'];
  emailAddress: string;
  host: string;
  port: string;
  username: string;
  /** Write-only: it is intentionally always blank when opening an existing queue. */
  password: string;
  useTls: boolean;
  departmentId: string;
  routingPriority: string;
  sendAutoresponder: boolean;
  isEnabled: boolean;
};

const EMPTY_QUEUE_FORM: QueueForm = {
  type: 'IMAP',
  emailAddress: '',
  host: '',
  port: '993',
  username: '',
  password: '',
  useTls: true,
  departmentId: '',
  routingPriority: '100',
  sendAutoresponder: false,
  isEnabled: false,
};

function queueFormFromQueue(queue: AdminEmailQueue): QueueForm {
  return {
    type: queue.type,
    emailAddress: queue.emailAddress,
    host: queue.host,
    port: String(queue.port),
    username: queue.username,
    password: '',
    useTls: queue.useTls,
    departmentId: queue.departmentId === null ? '' : String(queue.departmentId),
    routingPriority: String(queue.routingPriority),
    sendAutoresponder: queue.sendAutoresponder,
    isEnabled: queue.isEnabled,
  };
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: number }).status
    : undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error !== 'object' || error === null || !('data' in error)) return fallback;
  const message = (error as { data?: { message?: unknown } }).data?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

export function MailContent() {
  const queues = useEmailQueues();
  const health = useInboundHealth();
  const workflowEmailHealth = useWorkflowEmailHealth();
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
  const [workflowEventPage, setWorkflowEventPage] = useState(1);
  const [workflowEventState, setWorkflowEventState] = useState<WorkflowEmailEventState | ''>('');
  const workflowEvents = useWorkflowEmailEvents({
    page: workflowEventPage,
    state: workflowEventState || undefined,
  });
  const reconcile = useReconcileQueue();
  const replay = useReplayQuarantined();
  const replayWorkflowEmail = useReplayWorkflowEmailEvent();
  const { data: me } = useMe();
  const createQueue = useCreateEmailQueue();
  const updateQueue = useUpdateEmailQueue();
  const deleteQueue = useDeleteEmailQueue();

  const [reconcileFor, setReconcileFor] = useState<AdminEmailQueue | null>(null);
  const [detailFor, setDetailFor] = useState<QuarantinedDelivery | null>(null);
  const detail = useQuarantineDetail(detailFor?.id ?? null);
  const [replayFor, setReplayFor] = useState<QuarantinedDelivery | null>(null);
  const [replayReason, setReplayReason] = useState('');
  const [workflowDetailFor, setWorkflowDetailFor] = useState<WorkflowEmailEventListItem | null>(null);
  const workflowDetail = useWorkflowEmailEventDetail(workflowDetailFor?.id ?? null);
  const [workflowReplayFor, setWorkflowReplayFor] = useState<WorkflowEmailEventListItem | null>(null);
  const [workflowReplayReason, setWorkflowReplayReason] = useState('');
  const [mode, setMode] = useState<ReconcileMode>('RESUME_MIGRATED');
  const [reason, setReason] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [confirmationText, setConfirmationText] = useState('');
  const [backfillLimit, setBackfillLimit] = useState<number>(100);
  const [queueDialogOpen, setQueueDialogOpen] = useState(false);
  const [editingQueue, setEditingQueue] = useState<AdminEmailQueue | null>(null);
  const [queueForm, setQueueForm] = useState<QueueForm>(EMPTY_QUEUE_FORM);
  const canReconcile = hasPermission(me, PERMISSIONS.MAIL_RECONCILE);
  const canReplay = hasPermission(me, PERMISSIONS.MAIL_REPLAY);
  const canConfigure = hasPermission(me, PERMISSIONS.MAIL_CONFIGURE);
  const configMutationPending = createQueue.isPending || updateQueue.isPending || deleteQueue.isPending;

  function reloadQueueData() {
    void queues.refetch();
    void health.refetch();
    void workflowEmailHealth.refetch();
    void workflowEvents.refetch();
  }

  function openCreateQueue() {
    setEditingQueue(null);
    setQueueForm(EMPTY_QUEUE_FORM);
    setQueueDialogOpen(true);
  }

  function openEditQueue(queue: AdminEmailQueue) {
    if (queue.syncState === 'BOOTSTRAPPING') {
      toast({
        title: 'Очередь сейчас реконсилируется',
        description: 'Дождитесь завершения IMAP-baseline и обновите список перед изменением настроек.',
        variant: 'destructive',
      });
      return;
    }
    setEditingQueue(queue);
    setQueueForm(queueFormFromQueue(queue));
    setQueueDialogOpen(true);
  }

  function closeQueueDialog() {
    if (configMutationPending) return;
    setQueueDialogOpen(false);
    setEditingQueue(null);
    setQueueForm(EMPTY_QUEUE_FORM);
  }

  function handleQueueError(error: unknown, fallback: string) {
    if (errorStatus(error) === 409) {
      closeQueueDialog();
      reloadQueueData();
      toast({
        title: 'Настройки очереди уже изменились',
        description: 'Список обновлён. Откройте форму снова и повторите действие.',
        variant: 'destructive',
      });
      return;
    }
    toast({
      title: 'Не удалось сохранить очередь',
      description: errorMessage(error, fallback),
      variant: 'destructive',
    });
  }

  async function submitQueue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const emailAddress = queueForm.emailAddress.trim();
    const host = queueForm.host.trim();
    const username = queueForm.username.trim();
    const port = Number(queueForm.port);
    const routingPriority = Number(queueForm.routingPriority);
    const departmentId = queueForm.departmentId.trim() === '' ? null : Number(queueForm.departmentId);

    if (!/^\S+@\S+\.\S+$/.test(emailAddress)) {
      toast({ title: 'Укажите корректный адрес очереди', variant: 'destructive' });
      return;
    }
    if (!Number.isInteger(port) || port < 1) {
      toast({ title: 'Порт должен быть положительным целым числом', variant: 'destructive' });
      return;
    }
    if (!Number.isInteger(routingPriority) || routingPriority < 0 || routingPriority > 1_000_000) {
      toast({ title: 'Приоритет должен быть целым числом от 0 до 1 000 000', variant: 'destructive' });
      return;
    }
    if (departmentId !== null && (!Number.isInteger(departmentId) || departmentId < 1)) {
      toast({ title: 'ID отдела должен быть положительным целым числом или пустым', variant: 'destructive' });
      return;
    }
    if (queueForm.type !== 'PIPE' && (!host || !username)) {
      toast({ title: 'Для IMAP/POP3 укажите хост и имя пользователя', variant: 'destructive' });
      return;
    }

    const payload: EmailQueueConfigInput = {
      type: queueForm.type,
      emailAddress,
      host,
      port,
      username,
      useTls: queueForm.useTls,
      departmentId,
      routingPriority,
      sendAutoresponder: queueForm.sendAutoresponder,
      isEnabled: queueForm.isEnabled,
      ...(queueForm.password === '' ? {} : { password: queueForm.password }),
    };

    try {
      if (editingQueue) {
        if (!Number.isInteger(editingQueue.configGeneration)) {
          reloadQueueData();
          toast({
            title: 'Нужны свежие данные очереди',
            description: 'Сервер не вернул версию конфигурации. Список обновлён.',
            variant: 'destructive',
          });
          return;
        }
        await updateQueue.mutateAsync({
          id: editingQueue.id,
          expectedConfigGeneration: editingQueue.configGeneration,
          ...payload,
        });
        toast({ title: 'Очередь обновлена' });
      } else {
        await createQueue.mutateAsync(payload);
        toast({ title: 'Очередь создана' });
      }
      closeQueueDialog();
    } catch (error) {
      handleQueueError(error, 'Проверьте параметры очереди и права доступа.');
    }
  }

  async function toggleQueue(queue: AdminEmailQueue) {
    if (queue.syncState === 'BOOTSTRAPPING') return;
    if (!Number.isInteger(queue.configGeneration)) {
      reloadQueueData();
      toast({
        title: 'Нужны свежие данные очереди',
        description: 'Список обновлён.',
        variant: 'destructive',
      });
      return;
    }
    try {
      await updateQueue.mutateAsync({
        id: queue.id,
        expectedConfigGeneration: queue.configGeneration,
        isEnabled: !queue.isEnabled,
      });
      toast({ title: queue.isEnabled ? 'Очередь выключена' : 'Очередь включена' });
    } catch (error) {
      handleQueueError(error, 'Не удалось изменить состояние очереди.');
    }
  }

  async function deleteQueueById(queue: AdminEmailQueue) {
    if (queue.syncState === 'BOOTSTRAPPING') return;
    if (!Number.isInteger(queue.configGeneration)) {
      reloadQueueData();
      toast({
        title: 'Нужны свежие данные очереди',
        description: 'Список обновлён.',
        variant: 'destructive',
      });
      return;
    }
    if (!window.confirm(`Удалить очередь «${queue.emailAddress}»? Это действие нельзя отменить.`)) return;
    try {
      await deleteQueue.mutateAsync({
        id: queue.id,
        expectedConfigGeneration: queue.configGeneration,
      });
      toast({ title: 'Очередь удалена' });
    } catch (error) {
      handleQueueError(error, 'Не удалось удалить очередь.');
    }
  }

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

  function submitWorkflowEmailReplay() {
    if (!workflowReplayFor) return;
    replayWorkflowEmail.mutate(
      {
        eventId: workflowReplayFor.id,
        reason: workflowReplayReason.trim(),
        expectedUpdatedAt: workflowReplayFor.updatedAt,
      },
      {
        onSuccess: () => {
          toast({
            title: 'Workflow-email событие возвращено в обработку',
            description: workflowReplayFor.ticket.mask,
          });
          setWorkflowReplayFor(null);
          setWorkflowReplayReason('');
        },
        onError: (error: unknown) =>
          toast({
            title: 'Не удалось повторить workflow-email',
            description: errorMessage(
              error,
              'Обновите детали события и проверьте, что адрес заявителя не изменился.',
            ),
            variant: 'destructive',
          }),
      },
    );
  }

  const h = health.data;
  const workflowH = workflowEmailHealth.data;

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
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void queues.refetch();
              void health.refetch();
              void quarantine.refetch();
              void workflowEmailHealth.refetch();
              void workflowEvents.refetch();
            }}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Обновить
          </Button>
          {canConfigure && (
            <Button size="sm" onClick={openCreateQueue} disabled={configMutationPending}>
              <Plus className="mr-2 h-4 w-4" />
              Добавить очередь
            </Button>
          )}
        </div>
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

      {/* ── Durable workflow customer-email event health ─────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Workflow customer-email</h2>
        {workflowEmailHealth.isError ? (
          <QueryError onRetry={() => void workflowEmailHealth.refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: 'Бэклог', value: workflowH ? workflowH.backlog : '—' },
                { label: 'В обработке', value: workflowH ? workflowH.byState.processing : '—' },
                { label: 'Повтор', value: workflowH ? workflowH.byState.retry : '—' },
                { label: 'Карантин', value: workflowH ? workflowH.byState.quarantined : '—' },
                { label: 'Lease истёк', value: workflowH ? workflowH.stalledProcessing : '—' },
                { label: 'Обработано', value: workflowH ? workflowH.byState.processed : '—' },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border border-border bg-card p-3">
                  <div className="text-2xl font-bold tabular-nums">{item.value}</div>
                  <div className="text-xs text-muted-foreground">{item.label}</div>
                </div>
              ))}
            </div>
            {workflowH && workflowH.alerts.length > 0 && (
              <div className="space-y-2">
                {workflowH.alerts.map((alert) => (
                  <div
                    key={alert.kind}
                    className={
                      'flex items-start gap-2 rounded-lg border p-3 text-sm ' +
                      (alert.severity === 'critical'
                        ? 'border-destructive/40 bg-destructive/5 text-destructive'
                        : 'border-amber-500/40 bg-amber-500/5 text-amber-600 dark:text-amber-400')
                    }
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                    <span>{alert.message}</span>
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
                      <div className="mt-1 text-xs text-muted-foreground">
                        отдел: {q.departmentId ?? '—'} · автоответ: {q.sendAutoresponder ? 'вкл' : 'выкл'}
                      </div>
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
                      <div className="text-xs text-muted-foreground">cfg {q.configGeneration}</div>
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
                      <div className="flex flex-wrap justify-end gap-2">
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
                        {canConfigure && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={configMutationPending || q.syncState === 'BOOTSTRAPPING'}
                              title={
                                q.syncState === 'BOOTSTRAPPING'
                                  ? 'Настройки нельзя менять во время IMAP-baseline'
                                  : undefined
                              }
                              onClick={() => openEditQueue(q)}
                            >
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              Изменить
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={configMutationPending || q.syncState === 'BOOTSTRAPPING'}
                              title={
                                q.syncState === 'BOOTSTRAPPING'
                                  ? 'Настройки нельзя менять во время IMAP-baseline'
                                  : undefined
                              }
                              onClick={() => void toggleQueue(q)}
                            >
                              {q.isEnabled ? 'Выключить' : 'Включить'}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive"
                              disabled={configMutationPending || q.syncState === 'BOOTSTRAPPING'}
                              title={
                                q.syncState === 'BOOTSTRAPPING'
                                  ? 'Очередь нельзя удалять во время IMAP-baseline'
                                  : undefined
                              }
                              onClick={() => void deleteQueueById(q)}
                            >
                              <Trash2 className="mr-1 h-3.5 w-3.5" />
                              Удалить
                            </Button>
                          </>
                        )}
                      </div>
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

      {/* ── Workflow email event quarantine / recovery ───────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Workflow-email события {workflowEvents.data ? `(${workflowEvents.data.total})` : ''}
        </h2>
        {workflowEvents.isError ? (
          <QueryError onRetry={() => void workflowEvents.refetch()} />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Фильтр workflow-email по состоянию"
                className="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={workflowEventState}
                onChange={(event) => {
                  setWorkflowEventState(event.target.value as WorkflowEmailEventState | '');
                  setWorkflowEventPage(1);
                }}
              >
                <option value="">Все состояния</option>
                <option value="QUARANTINED">Карантин</option>
                <option value="RETRY">Повтор</option>
                <option value="PROCESSING">В обработке</option>
                <option value="PENDING">Ожидает</option>
                <option value="PROCESSED">Обработано</option>
              </select>
            </div>
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Тикет</TableHead>
                    <TableHead>Событие</TableHead>
                    <TableHead>Состояние</TableHead>
                    <TableHead>Попыток</TableHead>
                    <TableHead>Ошибка</TableHead>
                    <TableHead>Когда</TableHead>
                    <TableHead className="text-right">Действия</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(workflowEvents.data?.items ?? []).map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="font-medium">{event.ticket.mask}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{event.eventType}</TableCell>
                      <TableCell>
                        <Badge variant={event.state === 'QUARANTINED' ? 'destructive' : 'secondary'}>
                          {event.state}
                        </Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{event.attempts}</TableCell>
                      <TableCell
                        className="max-w-[18rem] truncate text-xs text-muted-foreground"
                        title={event.lastError ?? ''}
                      >
                        {event.lastError ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <RelativeTime date={event.updatedAt} />
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        <Button variant="ghost" size="sm" onClick={() => setWorkflowDetailFor(event)}>
                          Детали
                        </Button>
                        {canReplay && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={replayWorkflowEmail.isPending || event.state !== 'QUARANTINED'}
                            title={
                              event.state !== 'QUARANTINED'
                                ? 'Повтор доступен только из карантина'
                                : undefined
                            }
                            onClick={() => {
                              setWorkflowReplayFor(event);
                              setWorkflowReplayReason('');
                            }}
                          >
                            <RotateCcw className="mr-1 h-3.5 w-3.5" />
                            Повторить
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(workflowEvents.data?.items ?? []).length === 0 && !workflowEvents.isLoading && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                        Workflow-email событий в выбранной области нет.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            {workflowEvents.data && (
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Страница {workflowEvents.data.page} из{' '}
                  {Math.max(1, Math.ceil(workflowEvents.data.total / workflowEvents.data.limit))}
                </span>
                <div className="space-x-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={workflowEvents.data.page <= 1}
                    onClick={() => setWorkflowEventPage((page) => Math.max(1, page - 1))}
                  >
                    Назад
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      workflowEvents.data.page * workflowEvents.data.limit >= workflowEvents.data.total
                    }
                    onClick={() => setWorkflowEventPage((page) => page + 1)}
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

      {/* ── Workflow email event detail (body is detail-only) ─────────────── */}
      <Dialog open={workflowDetailFor !== null} onOpenChange={(open) => !open && setWorkflowDetailFor(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Workflow-email: {workflowDetail.data?.event.ticket.mask ?? workflowDetailFor?.ticket.mask}
            </DialogTitle>
          </DialogHeader>
          {workflowDetail.isError ? (
            <QueryError onRetry={() => void workflowDetail.refetch()} />
          ) : workflowDetail.data ? (
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-3 gap-2">
                <dt className="text-muted-foreground">Событие</dt>
                <dd className="col-span-2">{workflowDetail.data.event.eventType}</dd>
                <dt className="text-muted-foreground">Состояние</dt>
                <dd className="col-span-2">{workflowDetail.data.event.state}</dd>
                <dt className="text-muted-foreground">Попыток</dt>
                <dd className="col-span-2">{workflowDetail.data.event.attempts}</dd>
                <dt className="text-muted-foreground">Ошибка</dt>
                <dd className="col-span-2 break-words text-destructive">
                  {workflowDetail.data.event.lastError ?? '—'}
                </dd>
              </dl>
              {!workflowDetail.data.event.snapshotValid && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
                  Снимок действия повреждён. Повтор заблокирован, чтобы не отправить непроверенное письмо.
                </div>
              )}
              {workflowDetail.data.event.replayBlockReason && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-amber-700 dark:text-amber-300">
                  {workflowDetail.data.event.replayBlockReason}
                </div>
              )}
              <div className="space-y-3 border-t pt-3">
                <p className="font-medium">Неизменяемый снимок письма</p>
                {workflowDetail.data.event.actions.length === 0 ? (
                  <p className="text-muted-foreground">Нет валидного действия для отправки.</p>
                ) : (
                  workflowDetail.data.event.actions.map((action) => (
                    <div
                      key={`${action.workflowId}-${action.workflowVersionMs}-${action.actionIndex}`}
                      className="space-y-1 rounded-md border p-3"
                    >
                      <div className="text-xs text-muted-foreground">
                        Workflow #{action.workflowId}, action #{action.actionIndex}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Кому:</span> {action.to}
                      </div>
                      <div>
                        <span className="text-muted-foreground">Тема:</span> {action.subject}
                      </div>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
                        {action.text}
                      </pre>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Загрузка…</p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setWorkflowDetailFor(null)}>
              Закрыть
            </Button>
            {workflowDetail.data && canReplay && (
              <Button
                variant="outline"
                disabled={
                  replayWorkflowEmail.isPending ||
                  !workflowDetail.data.event.replayAllowed ||
                  workflowDetail.data.event.state !== 'QUARANTINED'
                }
                onClick={() => {
                  setWorkflowDetailFor(null);
                  setWorkflowReplayFor(workflowDetail.data!.event);
                  setWorkflowReplayReason('');
                }}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Повторить
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Workflow email replay: deliberate, version-fenced, audited ───── */}
      <Dialog open={workflowReplayFor !== null} onOpenChange={(open) => !open && setWorkflowReplayFor(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Повторить workflow-email: {workflowReplayFor?.ticket.mask}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Снимок письма и его idempotency key не меняются. Сервер повторно проверит адрес заявителя и версию
            события.
          </p>
          <Textarea
            id="workflow-email-replay-reason"
            aria-label="Причина повтора workflow-email"
            value={workflowReplayReason}
            onChange={(event) => setWorkflowReplayReason(event.target.value)}
            placeholder="Что исправлено и почему повтор безопасен"
            rows={3}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setWorkflowReplayFor(null)}>
              Отмена
            </Button>
            <Button
              disabled={replayWorkflowEmail.isPending || workflowReplayReason.trim().length === 0}
              onClick={submitWorkflowEmailReplay}
            >
              Подтвердить повтор
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password is deliberately write-only: editing never reads or renders the stored secret. */}
      <Dialog
        open={queueDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeQueueDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingQueue ? 'Изменить почтовую очередь' : 'Новая почтовая очередь'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={(event) => void submitQueue(event)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-type">
                  Тип
                </label>
                <select
                  id="mail-queue-type"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={queueForm.type}
                  onChange={(event) =>
                    setQueueForm((current) => ({
                      ...current,
                      type: event.target.value as QueueForm['type'],
                    }))
                  }
                  disabled={configMutationPending}
                >
                  <option value="IMAP">IMAP</option>
                  <option value="POP3">POP3</option>
                  <option value="PIPE">PIPE</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-address">
                  Адрес очереди
                </label>
                <Input
                  id="mail-queue-address"
                  type="email"
                  value={queueForm.emailAddress}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, emailAddress: event.target.value }))
                  }
                  autoComplete="off"
                  required
                  disabled={configMutationPending}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-host">
                  Хост
                </label>
                <Input
                  id="mail-queue-host"
                  value={queueForm.host}
                  onChange={(event) => setQueueForm((current) => ({ ...current, host: event.target.value }))}
                  placeholder={queueForm.type === 'PIPE' ? 'Не обязателен для PIPE' : 'imap.example.com'}
                  required={queueForm.type !== 'PIPE'}
                  autoComplete="off"
                  disabled={configMutationPending}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-port">
                  Порт
                </label>
                <Input
                  id="mail-queue-port"
                  type="number"
                  min={1}
                  value={queueForm.port}
                  onChange={(event) => setQueueForm((current) => ({ ...current, port: event.target.value }))}
                  disabled={configMutationPending}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-username">
                  Имя пользователя
                </label>
                <Input
                  id="mail-queue-username"
                  value={queueForm.username}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, username: event.target.value }))
                  }
                  required={queueForm.type !== 'PIPE'}
                  autoComplete="off"
                  disabled={configMutationPending}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-password">
                  Пароль
                </label>
                <Input
                  id="mail-queue-password"
                  type="password"
                  value={queueForm.password}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, password: event.target.value }))
                  }
                  placeholder={editingQueue ? 'Оставьте пустым, чтобы сохранить' : 'Необязательно'}
                  autoComplete="new-password"
                  disabled={configMutationPending}
                />
                <p className="text-xs text-muted-foreground">
                  {editingQueue
                    ? 'Текущий пароль не показывается и сохранится, если поле оставить пустым.'
                    : 'Пароль не сохраняется в браузере.'}
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-department">
                  ID отдела
                </label>
                <Input
                  id="mail-queue-department"
                  type="number"
                  min={1}
                  value={queueForm.departmentId}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, departmentId: event.target.value }))
                  }
                  placeholder="Пусто — без отдела"
                  inputMode="numeric"
                  disabled={configMutationPending}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="mail-queue-priority">
                  Приоритет маршрутизации
                </label>
                <Input
                  id="mail-queue-priority"
                  type="number"
                  min={0}
                  max={1_000_000}
                  value={queueForm.routingPriority}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, routingPriority: event.target.value }))
                  }
                  inputMode="numeric"
                  disabled={configMutationPending}
                />
                <p className="text-xs text-muted-foreground">Меньшее число имеет больший приоритет.</p>
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-border p-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="mail-queue-tls"
                  type="checkbox"
                  checked={queueForm.useTls}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, useTls: event.target.checked }))
                  }
                  disabled={configMutationPending}
                />
                Использовать TLS
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="mail-queue-autoresponder"
                  type="checkbox"
                  checked={queueForm.sendAutoresponder}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, sendAutoresponder: event.target.checked }))
                  }
                  disabled={configMutationPending}
                />
                Отправлять автоответ при создании заявки
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="mail-queue-enabled"
                  type="checkbox"
                  checked={queueForm.isEnabled}
                  onChange={(event) =>
                    setQueueForm((current) => ({ ...current, isEnabled: event.target.checked }))
                  }
                  disabled={configMutationPending}
                />
                Включить очередь после сохранения
              </label>
            </div>

            {editingQueue?.syncState === 'NEEDS_RECONCILIATION' && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
                После изменения идентичности IMAP-почтового ящика очередь останется остановленной, пока
                оператор не выполнит реконсиляцию.
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={closeQueueDialog}
                disabled={configMutationPending}
              >
                Отмена
              </Button>
              <Button type="submit" disabled={configMutationPending}>
                {configMutationPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
