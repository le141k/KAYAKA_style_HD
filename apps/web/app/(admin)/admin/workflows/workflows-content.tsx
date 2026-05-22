'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminWorkflows,
  useCreateWorkflow,
  useUpdateWorkflow,
  useDeleteWorkflow,
  useAdminMacros,
  useCreateMacro,
  useDeleteMacro,
  useAdminMacroCategories,
  type AdminWorkflow,
  type AdminMacro,
} from '@/lib/hooks/use-admin';

const workflowSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  isEnabled: z.boolean().optional(),
});
type WorkflowFormValues = z.infer<typeof workflowSchema>;

const macroSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  isShared: z.boolean().optional(),
  categoryId: z.coerce.number().nullable().optional(),
});
type MacroFormValues = z.infer<typeof macroSchema>;

export function WorkflowsContent() {
  const { data: workflows = [], isLoading: loadingWorkflows } = useAdminWorkflows();
  const { data: macros = [], isLoading: loadingMacros } = useAdminMacros();
  const { data: macroCategories = [] } = useAdminMacroCategories();

  const createWorkflow = useCreateWorkflow();
  const updateWorkflow = useUpdateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();

  const createMacro = useCreateMacro();
  const deleteMacro = useDeleteMacro();

  const [wfDialog, setWfDialog] = useState(false);
  const [editingWf, setEditingWf] = useState<AdminWorkflow | null>(null);

  const [macroDialog, setMacroDialog] = useState(false);
  const [editingMacro, setEditingMacro] = useState<AdminMacro | null>(null);

  const wfForm = useForm<WorkflowFormValues>({
    resolver: zodResolver(workflowSchema),
    defaultValues: { title: '', isEnabled: true },
  });

  const macroForm = useForm<MacroFormValues>({
    resolver: zodResolver(macroSchema),
    defaultValues: { title: '', isShared: true, categoryId: null },
  });

  function openCreateWf() {
    setEditingWf(null);
    wfForm.reset({ title: '', isEnabled: true });
    setWfDialog(true);
  }

  function openEditWf(wf: AdminWorkflow) {
    setEditingWf(wf);
    wfForm.reset({ title: wf.title, isEnabled: wf.isEnabled });
    setWfDialog(true);
  }

  async function onWfSubmit(values: WorkflowFormValues) {
    try {
      if (editingWf) {
        await updateWorkflow.mutateAsync({ id: editingWf.id, data: values });
        toast({ title: 'Правило обновлено' });
      } else {
        await createWorkflow.mutateAsync({ ...values, criteria: [], actions: [] });
        toast({ title: 'Правило создано' });
      }
      setWfDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить правило', variant: 'destructive' });
    }
  }

  async function handleDeleteWf(wf: AdminWorkflow) {
    if (!confirm(`Удалить правило «${wf.title}»?`)) return;
    try {
      await deleteWorkflow.mutateAsync(wf.id);
      toast({ title: 'Правило удалено' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить правило', variant: 'destructive' });
    }
  }

  function openCreateMacro() {
    setEditingMacro(null);
    macroForm.reset({ title: '', isShared: true, categoryId: null });
    setMacroDialog(true);
  }

  async function onMacroSubmit(values: MacroFormValues) {
    try {
      if (editingMacro) {
        toast({ title: 'Макросы редактируются через API (не реализовано в UI)' });
      } else {
        await createMacro.mutateAsync({ ...values, actions: [] });
        toast({ title: 'Макрос создан' });
      }
      setMacroDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить макрос', variant: 'destructive' });
    }
  }

  async function handleDeleteMacro(macro: AdminMacro) {
    if (!confirm(`Удалить макрос «${macro.title}»?`)) return;
    try {
      await deleteMacro.mutateAsync(macro.id);
      toast({ title: 'Макрос удалён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить макрос', variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Правила и макросы</h1>
        <p className="text-sm text-muted-foreground">Автоматизация рутинных операций</p>
      </div>

      {/* Workflows */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Правила автоматизации</h2>
          <Button size="sm" onClick={openCreateWf}>
            <Plus className="mr-1.5 h-4 w-4" />
            Создать правило
          </Button>
        </div>

        {loadingWorkflows ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : workflows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-12 text-center">
            <Zap className="mx-auto mb-3 h-8 w-8 text-muted-foreground opacity-40" />
            <p className="text-sm font-medium">Правил пока нет</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Создайте правило для автоматического назначения, изменения статуса или отправки уведомлений
            </p>
            <Button className="mt-4" size="sm" variant="outline" onClick={openCreateWf}>
              <Plus className="mr-1.5 h-4 w-4" />
              Создать первое правило
            </Button>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Название</TableHead>
                  <TableHead>Порядок</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead className="w-20">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((wf) => (
                  <TableRow key={wf.id}>
                    <TableCell className="font-medium">{wf.title}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{wf.sortOrder}</TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                          wf.isEnabled
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                            : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {wf.isEnabled ? 'Активно' : 'Выключено'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEditWf(wf)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteWf(wf)}
                          disabled={deleteWorkflow.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Macros */}
      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Макросы</h2>
          <Button size="sm" onClick={openCreateMacro}>
            <Plus className="mr-1.5 h-4 w-4" />
            Создать макрос
          </Button>
        </div>

        {loadingMacros ? (
          <p className="text-sm text-muted-foreground">Загрузка…</p>
        ) : macros.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <p className="text-sm text-muted-foreground">Макросов пока нет</p>
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Название</TableHead>
                  <TableHead>Категория</TableHead>
                  <TableHead>Общий</TableHead>
                  <TableHead className="w-16">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {macros.map((m) => {
                  const cat = macroCategories.find((c) => c.id === m.categoryId);
                  return (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">{m.title}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{cat ? cat.title : '—'}</TableCell>
                      <TableCell className="text-sm">{m.isShared ? 'Да' : 'Нет'}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteMacro(m)}
                          disabled={deleteMacro.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* Workflow dialog */}
      <Dialog open={wfDialog} onOpenChange={setWfDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingWf ? 'Редактировать правило' : 'Новое правило'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={wfForm.handleSubmit(onWfSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...wfForm.register('title')} placeholder="Название правила" />
              {wfForm.formState.errors.title && (
                <p className="text-xs text-destructive">{wfForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="wfEnabled" {...wfForm.register('isEnabled')} />
              <label htmlFor="wfEnabled" className="text-sm">
                Активно
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setWfDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createWorkflow.isPending || updateWorkflow.isPending}>
                {createWorkflow.isPending || updateWorkflow.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Macro dialog */}
      <Dialog open={macroDialog} onOpenChange={setMacroDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новый макрос</DialogTitle>
          </DialogHeader>
          <form onSubmit={macroForm.handleSubmit(onMacroSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...macroForm.register('title')} placeholder="Название макроса" />
              {macroForm.formState.errors.title && (
                <p className="text-xs text-destructive">{macroForm.formState.errors.title.message}</p>
              )}
            </div>
            {macroCategories.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Категория</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  {...macroForm.register('categoryId')}
                >
                  <option value="">— Без категории —</option>
                  {macroCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-2">
              <input type="checkbox" id="macroShared" {...macroForm.register('isShared')} defaultChecked />
              <label htmlFor="macroShared" className="text-sm">
                Общий (виден всем агентам)
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMacroDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createMacro.isPending}>
                {createMacro.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
