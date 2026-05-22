'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2 } from 'lucide-react';
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
  type AdminSlaPlan,
} from '@/lib/hooks/use-admin';

function fmtSeconds(s: number): string {
  if (s < 60) return `${s} сек`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.round(m / 60);
  return `${h} ч`;
}

const planSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  firstResponseSeconds: z.coerce.number().min(1, 'Должно быть > 0'),
  resolutionSeconds: z.coerce.number().min(1, 'Должно быть > 0'),
  isEnabled: z.boolean().optional(),
  scheduleId: z.coerce.number().nullable().optional(),
});
type PlanFormValues = z.infer<typeof planSchema>;

export function SlaContent() {
  const { data: plans = [], isLoading } = useAdminSlaPlans();
  const { data: schedules = [] } = useAdminSlaSchedules();
  const createPlan = useCreateSlaPlan();
  const updatePlan = useUpdateSlaPlan();
  const deletePlan = useDeleteSlaPlan();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminSlaPlan | null>(null);

  const form = useForm<PlanFormValues>({
    resolver: zodResolver(planSchema),
    defaultValues: {
      title: '',
      firstResponseSeconds: 3600,
      resolutionSeconds: 86400,
      isEnabled: true,
      scheduleId: null,
    },
  });

  function openCreate() {
    setEditing(null);
    form.reset({
      title: '',
      firstResponseSeconds: 3600,
      resolutionSeconds: 86400,
      isEnabled: true,
      scheduleId: null,
    });
    setDialogOpen(true);
  }

  function openEdit(plan: AdminSlaPlan) {
    setEditing(plan);
    form.reset({
      title: plan.title,
      firstResponseSeconds: plan.firstResponseSeconds,
      resolutionSeconds: plan.resolutionSeconds,
      isEnabled: plan.isEnabled,
      scheduleId: plan.scheduleId,
    });
    setDialogOpen(true);
  }

  async function onSubmit(values: PlanFormValues) {
    try {
      if (editing) {
        await updatePlan.mutateAsync({ id: editing.id, data: values });
        toast({ title: 'SLA-план обновлён' });
      } else {
        await createPlan.mutateAsync(values);
        toast({ title: 'SLA-план создан' });
      }
      setDialogOpen(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить план', variant: 'destructive' });
    }
  }

  async function handleDelete(plan: AdminSlaPlan) {
    if (!confirm(`Удалить SLA-план «${plan.title}»?`)) return;
    try {
      await deletePlan.mutateAsync(plan.id);
      toast({ title: 'SLA-план удалён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить план', variant: 'destructive' });
    }
  }

  const isBusy = createPlan.isPending || updatePlan.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">SLA-планы</h1>
          <p className="text-sm text-muted-foreground">Настройка временных ограничений для заявок</p>
        </div>
        <Button size="sm" onClick={openCreate}>
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
              <TableHead className="w-20">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  Загрузка…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && plans.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  Нет SLA-планов
                </TableCell>
              </TableRow>
            )}
            {plans.map((plan) => {
              const schedule = schedules.find((s) => s.id === plan.scheduleId);
              return (
                <TableRow key={plan.id}>
                  <TableCell className="font-medium">{plan.title}</TableCell>
                  <TableCell className="font-mono text-sm">{fmtSeconds(plan.firstResponseSeconds)}</TableCell>
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
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(plan)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(plan)}
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Редактировать SLA-план' : 'Новый SLA-план'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...form.register('title')} placeholder="Название плана" />
              {form.formState.errors.title && (
                <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Первый ответ (сек)</label>
                <Input type="number" min={1} {...form.register('firstResponseSeconds')} />
                {form.formState.errors.firstResponseSeconds && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.firstResponseSeconds.message}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Решение (сек)</label>
                <Input type="number" min={1} {...form.register('resolutionSeconds')} />
                {form.formState.errors.resolutionSeconds && (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.resolutionSeconds.message}
                  </p>
                )}
              </div>
            </div>
            {schedules.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">График работы</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  {...form.register('scheduleId')}
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
              <input type="checkbox" id="isEnabled" {...form.register('isEnabled')} />
              <label htmlFor="isEnabled" className="text-sm">
                Активен
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={isBusy}>
                {isBusy ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
