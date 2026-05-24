'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminStatuses,
  useCreateStatus,
  useUpdateStatus,
  useDeleteStatus,
  useAdminPriorities,
  useCreatePriority,
  useUpdatePriority,
  useDeletePriority,
  type AdminTicketStatus,
  type AdminTicketPriority,
} from '@/lib/hooks/use-admin';

const statusSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  color: z.string().optional(),
  bgColor: z.string().optional(),
  markAsResolved: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  displayOrder: z.coerce.number().int().optional(),
  triggersSurvey: z.boolean().optional(),
  displayIcon: z.string().optional(),
});
type StatusFormValues = z.infer<typeof statusSchema>;

const prioritySchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  color: z.string().optional(),
  bgColor: z.string().optional(),
  displayOrder: z.coerce.number().int().optional(),
});
type PriorityFormValues = z.infer<typeof prioritySchema>;

function ColorSwatch({ color, bg }: { color: string; bg: string }) {
  return (
    <span
      className="inline-flex h-5 w-10 items-center justify-center rounded text-xs font-semibold"
      style={{ color, backgroundColor: bg }}
    >
      Aa
    </span>
  );
}

export function StatusesContent() {
  const { data: statuses = [], isLoading: loadingStatuses } = useAdminStatuses();
  const { data: priorities = [], isLoading: loadingPriorities } = useAdminPriorities();

  const createStatus = useCreateStatus();
  const updateStatus = useUpdateStatus();
  const deleteStatus = useDeleteStatus();

  const createPriority = useCreatePriority();
  const updatePriority = useUpdatePriority();
  const deletePriority = useDeletePriority();

  const [statusDialog, setStatusDialog] = useState(false);
  const [editingStatus, setEditingStatus] = useState<AdminTicketStatus | null>(null);
  const [statusDeleteError, setStatusDeleteError] = useState<string | null>(null);

  const [priorityDialog, setPriorityDialog] = useState(false);
  const [editingPriority, setEditingPriority] = useState<AdminTicketPriority | null>(null);
  const [priorityDeleteError, setPriorityDeleteError] = useState<string | null>(null);

  const statusForm = useForm<StatusFormValues>({
    resolver: zodResolver(statusSchema),
    defaultValues: {
      title: '',
      color: '#ffffff',
      bgColor: '#22c55e',
      markAsResolved: false,
      isDefault: false,
      displayOrder: 0,
      triggersSurvey: false,
      displayIcon: '',
    },
  });

  const priorityForm = useForm<PriorityFormValues>({
    resolver: zodResolver(prioritySchema),
    defaultValues: { title: '', color: '#374151', bgColor: '#dbeafe', displayOrder: 0 },
  });

  function openCreateStatus() {
    setEditingStatus(null);
    statusForm.reset({
      title: '',
      color: '#ffffff',
      bgColor: '#22c55e',
      markAsResolved: false,
      isDefault: false,
      displayOrder: 0,
      triggersSurvey: false,
      displayIcon: '',
    });
    setStatusDialog(true);
  }

  function openEditStatus(s: AdminTicketStatus) {
    setEditingStatus(s);
    statusForm.reset({
      title: s.title,
      color: s.color,
      bgColor: s.bgColor,
      markAsResolved: s.markAsResolved,
      isDefault: s.isDefault,
      displayOrder: s.displayOrder,
    });
    setStatusDialog(true);
  }

  async function onStatusSubmit(values: StatusFormValues) {
    try {
      if (editingStatus) {
        await updateStatus.mutateAsync({ id: editingStatus.id, data: values });
        toast({ title: 'Статус обновлён' });
      } else {
        await createStatus.mutateAsync(values);
        toast({ title: 'Статус создан' });
      }
      setStatusDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить статус', variant: 'destructive' });
    }
  }

  async function handleDeleteStatus(s: AdminTicketStatus) {
    if (!confirm(`Удалить статус «${s.title}»?`)) return;
    setStatusDeleteError(null);
    try {
      await deleteStatus.mutateAsync(s.id);
      toast({ title: 'Статус удалён' });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        setStatusDeleteError(
          `Нельзя удалить статус «${s.title}» — он используется в заявках. Сначала переназначьте заявки на другой статус.`,
        );
      } else {
        toast({ title: 'Ошибка', description: 'Не удалось удалить статус', variant: 'destructive' });
      }
    }
  }

  function openCreatePriority() {
    setEditingPriority(null);
    priorityForm.reset({ title: '', color: '#374151', bgColor: '#dbeafe', displayOrder: 0 });
    setPriorityDialog(true);
  }

  function openEditPriority(p: AdminTicketPriority) {
    setEditingPriority(p);
    priorityForm.reset({ title: p.title, color: p.color, bgColor: p.bgColor, displayOrder: p.displayOrder });
    setPriorityDialog(true);
  }

  async function onPrioritySubmit(values: PriorityFormValues) {
    try {
      if (editingPriority) {
        await updatePriority.mutateAsync({ id: editingPriority.id, data: values });
        toast({ title: 'Приоритет обновлён' });
      } else {
        await createPriority.mutateAsync(values);
        toast({ title: 'Приоритет создан' });
      }
      setPriorityDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить приоритет', variant: 'destructive' });
    }
  }

  async function handleDeletePriority(p: AdminTicketPriority) {
    if (!confirm(`Удалить приоритет «${p.title}»?`)) return;
    setPriorityDeleteError(null);
    try {
      await deletePriority.mutateAsync(p.id);
      toast({ title: 'Приоритет удалён' });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        setPriorityDeleteError(`Нельзя удалить приоритет «${p.title}» — он используется в заявках.`);
      } else {
        toast({ title: 'Ошибка', description: 'Не удалось удалить приоритет', variant: 'destructive' });
      }
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Статусы и приоритеты</h1>
        <p className="text-sm text-muted-foreground">Конфигурация жизненного цикла заявок</p>
      </div>

      {/* Statuses */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Статусы заявок</h2>
          <Button size="sm" onClick={openCreateStatus}>
            <Plus className="mr-1.5 h-4 w-4" />
            Добавить
          </Button>
        </div>

        {statusDeleteError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {statusDeleteError}
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 h-5 px-2 text-xs"
              onClick={() => setStatusDeleteError(null)}
            >
              ✕
            </Button>
          </div>
        )}

        {loadingStatuses ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {statuses.map((s) => (
              <div key={s.id} className="rounded-lg border border-border bg-card p-4 min-w-[160px]">
                <div className="flex items-center justify-between gap-2">
                  <ColorSwatch color={s.color} bg={s.bgColor} />
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => openEditStatus(s)}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => handleDeleteStatus(s)}
                      disabled={deleteStatus.isPending}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <p className="mt-2 font-medium text-sm">{s.title}</p>
                <div className="mt-1 space-y-0.5">
                  {s.markAsResolved && <p className="text-xs text-muted-foreground">Закрывает заявку</p>}
                  {s.isDefault && (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-xs text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                      По умолч.
                    </span>
                  )}
                  <p className="text-xs text-muted-foreground">Порядок: {s.displayOrder}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Priorities */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Приоритеты</h2>
          <Button size="sm" onClick={openCreatePriority}>
            <Plus className="mr-1.5 h-4 w-4" />
            Добавить
          </Button>
        </div>

        {priorityDeleteError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {priorityDeleteError}
            <Button
              variant="ghost"
              size="sm"
              className="ml-2 h-5 px-2 text-xs"
              onClick={() => setPriorityDeleteError(null)}
            >
              ✕
            </Button>
          </div>
        )}

        {loadingPriorities ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : (
          <div className="flex flex-wrap gap-3">
            {priorities.map((p) => (
              <div key={p.id} className="rounded-lg border border-border bg-card p-4 min-w-[140px]">
                <div className="flex items-center justify-between gap-2">
                  <ColorSwatch color={p.color} bg={p.bgColor} />
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={() => openEditPriority(p)}
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive"
                      onClick={() => handleDeletePriority(p)}
                      disabled={deletePriority.isPending}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
                <p className="mt-2 font-medium text-sm">{p.title}</p>
                <p className="text-xs text-muted-foreground">Порядок: {p.displayOrder}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Status dialog */}
      <Dialog open={statusDialog} onOpenChange={setStatusDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingStatus ? 'Редактировать статус' : 'Новый статус'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={statusForm.handleSubmit(onStatusSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...statusForm.register('title')} placeholder="Название статуса" />
              {statusForm.formState.errors.title && (
                <p className="text-xs text-destructive">{statusForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Цвет текста</label>
                <Input type="color" {...statusForm.register('color')} className="h-9 px-2" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Цвет фона</label>
                <Input type="color" {...statusForm.register('bgColor')} className="h-9 px-2" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Порядок отображения</label>
              <Input type="number" min={0} {...statusForm.register('displayOrder')} className="h-8" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Иконка (CSS-класс или emoji)</label>
              <Input {...statusForm.register('displayIcon')} placeholder="Необязательно" />
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input type="checkbox" id="markAsResolved" {...statusForm.register('markAsResolved')} />
                <label htmlFor="markAsResolved" className="text-sm">
                  Закрывает заявку
                </label>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="statusIsDefault" {...statusForm.register('isDefault')} />
                <label htmlFor="statusIsDefault" className="text-sm">
                  По умолчанию
                </label>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="triggersSurvey" {...statusForm.register('triggersSurvey')} />
                <label htmlFor="triggersSurvey" className="text-sm">
                  Запускает опрос удовлетворённости
                </label>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStatusDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createStatus.isPending || updateStatus.isPending}>
                {createStatus.isPending || updateStatus.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Priority dialog */}
      <Dialog open={priorityDialog} onOpenChange={setPriorityDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingPriority ? 'Редактировать приоритет' : 'Новый приоритет'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={priorityForm.handleSubmit(onPrioritySubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...priorityForm.register('title')} placeholder="Название приоритета" />
              {priorityForm.formState.errors.title && (
                <p className="text-xs text-destructive">{priorityForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Цвет текста</label>
                <Input type="color" {...priorityForm.register('color')} className="h-9 px-2" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Цвет фона</label>
                <Input type="color" {...priorityForm.register('bgColor')} className="h-9 px-2" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Порядок отображения</label>
              <Input type="number" min={0} {...priorityForm.register('displayOrder')} className="h-8" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPriorityDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createPriority.isPending || updatePriority.isPending}>
                {createPriority.isPending || updatePriority.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
