'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminSlaPlans,
  useCreateSlaPlan,
  useUpdateSlaPlan,
  useDeleteSlaPlan,
  useAdminSlaSchedules,
  useCreateSlaSchedule,
  useUpdateSlaSchedule,
  useDeleteSlaSchedule,
  useAdminSlaHolidays,
  useCreateSlaHoliday,
  useUpdateSlaHoliday,
  useDeleteSlaHoliday,
  useAdminEscalationRules,
  useCreateEscalationRule,
  useUpdateEscalationRule,
  useDeleteEscalationRule,
  type AdminSlaPlan,
  type AdminSlaSchedule,
  type AdminSlaHoliday,
  type AdminEscalationRule,
} from '@/lib/hooks/use-admin';

function fmtSeconds(s: number): string {
  if (s < 60) return `${s} сек`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  return `${h} ч`;
}

// ─── SLA plan form ────────────────────────────────────────────────────────────

const planSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  firstResponseSeconds: z.coerce.number().min(1, 'Должно быть > 0'),
  resolutionSeconds: z.coerce.number().min(1, 'Должно быть > 0'),
  isEnabled: z.boolean().optional(),
  scheduleId: z.coerce.number().nullable().optional(),
});
type PlanFormValues = z.infer<typeof planSchema>;

// ─── Schedule form ────────────────────────────────────────────────────────────

const scheduleSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
});
type ScheduleFormValues = z.infer<typeof scheduleSchema>;

// ─── Holiday form ─────────────────────────────────────────────────────────────

const holidaySchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  date: z.string().min(1, 'Обязательное поле'),
});
type HolidayFormValues = z.infer<typeof holidaySchema>;

// ─── Escalation rule form ─────────────────────────────────────────────────────

const escalationSchema = z.object({
  name: z.string().min(1, 'Обязательное поле'),
  targetType: z.enum(['FIRST_RESPONSE', 'RESOLUTION']),
  thresholdSeconds: z.coerce.number().min(1, 'Должно быть > 0'),
  isEnabled: z.boolean().optional(),
});
type EscalationFormValues = z.infer<typeof escalationSchema>;

// ─── Schedule row (with holidays) ────────────────────────────────────────────

function ScheduleRow({
  schedule,
  onEdit,
  onDelete,
}: {
  schedule: AdminSlaSchedule;
  onEdit: (s: AdminSlaSchedule) => void;
  onDelete: (s: AdminSlaSchedule) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { data: holidays = [] } = useAdminSlaHolidays(expanded ? schedule.id : 0);
  const createHoliday = useCreateSlaHoliday(schedule.id);
  const updateHoliday = useUpdateSlaHoliday(schedule.id);
  const deleteHoliday = useDeleteSlaHoliday(schedule.id);

  const [holidayDialog, setHolidayDialog] = useState(false);
  const [editingHoliday, setEditingHoliday] = useState<AdminSlaHoliday | null>(null);

  const holidayForm = useForm<HolidayFormValues>({
    resolver: zodResolver(holidaySchema),
    defaultValues: { title: '', date: '' },
  });

  function openCreateHoliday() {
    setEditingHoliday(null);
    holidayForm.reset({ title: '', date: '' });
    setHolidayDialog(true);
  }

  function openEditHoliday(h: AdminSlaHoliday) {
    setEditingHoliday(h);
    holidayForm.reset({ title: h.title, date: h.date });
    setHolidayDialog(true);
  }

  async function onHolidaySubmit(values: HolidayFormValues) {
    try {
      if (editingHoliday) {
        await updateHoliday.mutateAsync({ id: editingHoliday.id, data: values });
        toast({ title: 'Выходной обновлён' });
      } else {
        await createHoliday.mutateAsync(values);
        toast({ title: 'Выходной добавлен' });
      }
      setHolidayDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить выходной', variant: 'destructive' });
    }
  }

  async function handleDeleteHoliday(h: AdminSlaHoliday) {
    if (!confirm(`Удалить выходной «${h.title}»?`)) return;
    try {
      await deleteHoliday.mutateAsync(h.id);
      toast({ title: 'Выходной удалён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить выходной', variant: 'destructive' });
    }
  }

  return (
    <>
      <TableRow>
        <TableCell>
          <button
            type="button"
            className="flex items-center gap-1 font-medium hover:underline"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            {schedule.title}
          </button>
        </TableCell>
        <TableCell>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onEdit(schedule)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onDelete(schedule)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        <TableRow>
          <TableCell colSpan={2} className="bg-muted/30 p-4">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Выходные дни</span>
                <Button size="sm" variant="outline" onClick={openCreateHoliday}>
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Добавить
                </Button>
              </div>
              {holidays.length === 0 ? (
                <p className="text-xs text-muted-foreground">Выходных нет</p>
              ) : (
                <div className="space-y-1">
                  {holidays.map((h) => (
                    <div
                      key={h.id}
                      className="flex items-center justify-between rounded-md border bg-background px-3 py-1.5"
                    >
                      <span className="text-sm">
                        {h.title} <span className="text-muted-foreground text-xs">({h.date})</span>
                      </span>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => openEditHoliday(h)}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteHoliday(h)}
                          disabled={deleteHoliday.isPending}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}

      <Dialog open={holidayDialog} onOpenChange={setHolidayDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingHoliday ? 'Редактировать выходной' : 'Добавить выходной'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={holidayForm.handleSubmit(onHolidaySubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...holidayForm.register('title')} placeholder="Новый год" />
              {holidayForm.formState.errors.title && (
                <p className="text-xs text-destructive">{holidayForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Дата</label>
              <Input type="date" {...holidayForm.register('date')} />
              {holidayForm.formState.errors.date && (
                <p className="text-xs text-destructive">{holidayForm.formState.errors.date.message}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setHolidayDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createHoliday.isPending || updateHoliday.isPending}>
                {createHoliday.isPending || updateHoliday.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ─── Escalation rules section (per-plan) ─────────────────────────────────────

function EscalationRulesSection({ plan }: { plan: AdminSlaPlan }) {
  const [expanded, setExpanded] = useState(false);
  const { data: rules = [] } = useAdminEscalationRules(expanded ? plan.id : 0);
  const createRule = useCreateEscalationRule(plan.id);
  const updateRule = useUpdateEscalationRule(plan.id);
  const deleteRule = useDeleteEscalationRule(plan.id);

  const [ruleDialog, setRuleDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<AdminEscalationRule | null>(null);

  const ruleForm = useForm<EscalationFormValues>({
    resolver: zodResolver(escalationSchema),
    defaultValues: { name: '', targetType: 'FIRST_RESPONSE', thresholdSeconds: 3600, isEnabled: true },
  });

  function openCreateRule() {
    setEditingRule(null);
    ruleForm.reset({ name: '', targetType: 'FIRST_RESPONSE', thresholdSeconds: 3600, isEnabled: true });
    setRuleDialog(true);
  }

  function openEditRule(rule: AdminEscalationRule) {
    setEditingRule(rule);
    ruleForm.reset({
      name: rule.name,
      targetType: rule.targetType,
      thresholdSeconds: rule.thresholdSeconds,
      isEnabled: rule.isEnabled,
    });
    setRuleDialog(true);
  }

  async function onRuleSubmit(values: EscalationFormValues) {
    try {
      if (editingRule) {
        await updateRule.mutateAsync({
          id: editingRule.id,
          data: { ...values, actions: editingRule.actions },
        });
        toast({ title: 'Правило эскалации обновлено' });
      } else {
        await createRule.mutateAsync(values);
        toast({ title: 'Правило эскалации создано' });
      }
      setRuleDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить правило', variant: 'destructive' });
    }
  }

  async function handleDeleteRule(rule: AdminEscalationRule) {
    if (!confirm(`Удалить правило эскалации «${rule.name}»?`)) return;
    try {
      await deleteRule.mutateAsync(rule.id);
      toast({ title: 'Правило удалено' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить правило', variant: 'destructive' });
    }
  }

  return (
    <div>
      <button
        type="button"
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Правила эскалации
        {plan.escalationRules.length > 0 && (
          <span className="ml-1 rounded-full bg-muted px-1.5 py-0.5 text-xs">
            {plan.escalationRules.length}
          </span>
        )}
      </button>

      {expanded && (
        <div className="mt-3 ml-5 space-y-3">
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={openCreateRule}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Добавить правило
            </Button>
          </div>
          {rules.length === 0 ? (
            <p className="text-xs text-muted-foreground">Правил эскалации нет</p>
          ) : (
            <div className="space-y-1">
              {rules.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded-md border bg-card px-3 py-2"
                >
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {r.targetType === 'FIRST_RESPONSE' ? 'Первый ответ' : 'Решение'} ·{' '}
                      {fmtSeconds(r.thresholdSeconds)} · {r.isEnabled ? 'Активно' : 'Выключено'}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEditRule(r)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteRule(r)}
                      disabled={deleteRule.isPending}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={ruleDialog} onOpenChange={setRuleDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingRule ? 'Редактировать правило эскалации' : 'Новое правило эскалации'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={ruleForm.handleSubmit(onRuleSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...ruleForm.register('name')} placeholder="Эскалация при просрочке" />
              {ruleForm.formState.errors.name && (
                <p className="text-xs text-destructive">{ruleForm.formState.errors.name.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Цель</label>
              <select
                {...ruleForm.register('targetType')}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              >
                <option value="FIRST_RESPONSE">Первый ответ</option>
                <option value="RESOLUTION">Решение</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Порог (секунд)</label>
              <Input type="number" min={1} {...ruleForm.register('thresholdSeconds')} />
              {ruleForm.formState.errors.thresholdSeconds && (
                <p className="text-xs text-destructive">
                  {ruleForm.formState.errors.thresholdSeconds.message}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="ruleEnabled" {...ruleForm.register('isEnabled')} />
              <label htmlFor="ruleEnabled" className="text-sm">
                Активно
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRuleDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createRule.isPending || updateRule.isPending}>
                {createRule.isPending || updateRule.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Main SlaContent ──────────────────────────────────────────────────────────

export function SlaContent() {
  const { data: plans = [], isLoading } = useAdminSlaPlans();
  const { data: schedules = [], isLoading: loadingSchedules } = useAdminSlaSchedules();
  const createPlan = useCreateSlaPlan();
  const updatePlan = useUpdateSlaPlan();
  const deletePlan = useDeleteSlaPlan();

  const createSchedule = useCreateSlaSchedule();
  const updateSchedule = useUpdateSlaSchedule();
  const deleteSchedule = useDeleteSlaSchedule();

  const [planDialogOpen, setPlanDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<AdminSlaPlan | null>(null);

  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<AdminSlaSchedule | null>(null);

  const planForm = useForm<PlanFormValues>({
    resolver: zodResolver(planSchema),
    defaultValues: {
      title: '',
      firstResponseSeconds: 3600,
      resolutionSeconds: 86400,
      isEnabled: true,
      scheduleId: null,
    },
  });

  const scheduleForm = useForm<ScheduleFormValues>({
    resolver: zodResolver(scheduleSchema),
    defaultValues: { title: '' },
  });

  function openCreatePlan() {
    setEditingPlan(null);
    planForm.reset({
      title: '',
      firstResponseSeconds: 3600,
      resolutionSeconds: 86400,
      isEnabled: true,
      scheduleId: null,
    });
    setPlanDialogOpen(true);
  }

  function openEditPlan(plan: AdminSlaPlan) {
    setEditingPlan(plan);
    planForm.reset({
      title: plan.title,
      firstResponseSeconds: plan.firstResponseSeconds,
      resolutionSeconds: plan.resolutionSeconds,
      isEnabled: plan.isEnabled,
      scheduleId: plan.scheduleId,
    });
    setPlanDialogOpen(true);
  }

  async function onPlanSubmit(values: PlanFormValues) {
    try {
      if (editingPlan) {
        await updatePlan.mutateAsync({ id: editingPlan.id, data: values });
        toast({ title: 'SLA-план обновлён' });
      } else {
        await createPlan.mutateAsync(values);
        toast({ title: 'SLA-план создан' });
      }
      setPlanDialogOpen(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить план', variant: 'destructive' });
    }
  }

  async function handleDeletePlan(plan: AdminSlaPlan) {
    if (!confirm(`Удалить SLA-план «${plan.title}»?`)) return;
    try {
      await deletePlan.mutateAsync(plan.id);
      toast({ title: 'SLA-план удалён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить план', variant: 'destructive' });
    }
  }

  function openCreateSchedule() {
    setEditingSchedule(null);
    scheduleForm.reset({ title: '' });
    setScheduleDialogOpen(true);
  }

  function openEditSchedule(schedule: AdminSlaSchedule) {
    setEditingSchedule(schedule);
    scheduleForm.reset({ title: schedule.title });
    setScheduleDialogOpen(true);
  }

  async function onScheduleSubmit(values: ScheduleFormValues) {
    try {
      if (editingSchedule) {
        await updateSchedule.mutateAsync({ id: editingSchedule.id, data: values });
        toast({ title: 'График обновлён' });
      } else {
        await createSchedule.mutateAsync(values);
        toast({ title: 'График создан' });
      }
      setScheduleDialogOpen(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить график', variant: 'destructive' });
    }
  }

  async function handleDeleteSchedule(schedule: AdminSlaSchedule) {
    if (!confirm(`Удалить график «${schedule.title}»?`)) return;
    try {
      await deleteSchedule.mutateAsync(schedule.id);
      toast({ title: 'График удалён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить график', variant: 'destructive' });
    }
  }

  const isPlanBusy = createPlan.isPending || updatePlan.isPending;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">SLA</h1>
        <p className="text-sm text-muted-foreground">Временные ограничения, графики работы и эскалации</p>
      </div>

      {/* ─── Schedules ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Графики работы</h2>
          <Button size="sm" onClick={openCreateSchedule}>
            <Plus className="mr-1.5 h-4 w-4" />
            Добавить график
          </Button>
        </div>

        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Название</TableHead>
                <TableHead className="w-20">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loadingSchedules && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-muted-foreground py-6">
                    Загрузка…
                  </TableCell>
                </TableRow>
              )}
              {!loadingSchedules && schedules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={2} className="text-center text-muted-foreground py-6">
                    Нет графиков
                  </TableCell>
                </TableRow>
              )}
              {schedules.map((s) => (
                <ScheduleRow
                  key={s.id}
                  schedule={s}
                  onEdit={openEditSchedule}
                  onDelete={handleDeleteSchedule}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* ─── SLA Plans ─────────────────────────────────────────────────────── */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">SLA-планы</h2>
          <Button size="sm" onClick={openCreatePlan}>
            <Plus className="mr-1.5 h-4 w-4" />
            Добавить план
          </Button>
        </div>

        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Название</TableHead>
                <TableHead>Первый ответ</TableHead>
                <TableHead>Решение</TableHead>
                <TableHead>График</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Эскалации</TableHead>
                <TableHead className="w-20">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    Загрузка…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && plans.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                    Нет SLA-планов
                  </TableCell>
                </TableRow>
              )}
              {plans.map((plan) => {
                const schedule = schedules.find((s) => s.id === plan.scheduleId);
                return (
                  <TableRow key={plan.id}>
                    <TableCell className="font-medium">{plan.title}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {fmtSeconds(plan.firstResponseSeconds)}
                    </TableCell>
                    <TableCell className="font-mono text-sm">{fmtSeconds(plan.resolutionSeconds)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {schedule ? schedule.title : '—'}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          plan.isEnabled
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {plan.isEnabled ? 'Активен' : 'Выключен'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <EscalationRulesSection plan={plan} />
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEditPlan(plan)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDeletePlan(plan)}
                          disabled={deletePlan.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* ─── Plan dialog ────────────────────────────────────────────────────── */}
      <Dialog open={planDialogOpen} onOpenChange={setPlanDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingPlan ? 'Редактировать SLA-план' : 'Новый SLA-план'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={planForm.handleSubmit(onPlanSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...planForm.register('title')} placeholder="Название плана" />
              {planForm.formState.errors.title && (
                <p className="text-xs text-destructive">{planForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Первый ответ (сек)</label>
                <Input type="number" min={1} {...planForm.register('firstResponseSeconds')} />
                {planForm.formState.errors.firstResponseSeconds && (
                  <p className="text-xs text-destructive">
                    {planForm.formState.errors.firstResponseSeconds.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Решение (сек)</label>
                <Input type="number" min={1} {...planForm.register('resolutionSeconds')} />
                {planForm.formState.errors.resolutionSeconds && (
                  <p className="text-xs text-destructive">
                    {planForm.formState.errors.resolutionSeconds.message}
                  </p>
                )}
              </div>
            </div>
            {schedules.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">График работы</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  {...planForm.register('scheduleId')}
                >
                  <option value="">— Без графика —</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input type="checkbox" id="isEnabled" {...planForm.register('isEnabled')} />
              <label htmlFor="isEnabled" className="text-sm">
                Активен
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPlanDialogOpen(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={isPlanBusy}>
                {isPlanBusy ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ─── Schedule dialog ────────────────────────────────────────────────── */}
      <Dialog open={scheduleDialogOpen} onOpenChange={setScheduleDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingSchedule ? 'Редактировать график' : 'Новый график'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={scheduleForm.handleSubmit(onScheduleSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...scheduleForm.register('title')} placeholder="Рабочие часы" />
              {scheduleForm.formState.errors.title && (
                <p className="text-xs text-destructive">{scheduleForm.formState.errors.title.message}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setScheduleDialogOpen(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createSchedule.isPending || updateSchedule.isPending}>
                {createSchedule.isPending || updateSchedule.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
