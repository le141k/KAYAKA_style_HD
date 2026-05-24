'use client';

import { useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
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
  useUpdateMacro,
  useDeleteMacro,
  useAdminMacroCategories,
  useCreateMacroCategory,
  useUpdateMacroCategory,
  useDeleteMacroCategory,
  useAdminStatuses,
  useAdminPriorities,
  useAdminDepartments,
  useAdminStaff,
  type AdminWorkflow,
  type AdminMacro,
  type AdminMacroCategory,
} from '@/lib/hooks/use-admin';

// ─── Criterion row schema ────────────────────────────────────────────────────

const criterionSchema = z.object({
  field: z.string().min(1, 'Поле обязательно'),
  op: z.string().min(1, 'Оператор обязателен'),
  value: z.string(),
});

const actionSchema = z.object({
  type: z.string().min(1, 'Тип обязателен'),
  value: z.string(),
});

// ─── Workflow form ────────────────────────────────────────────────────────────

const workflowSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  isEnabled: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
  criteria: z.array(criterionSchema),
  actions: z.array(actionSchema),
});
type WorkflowFormValues = z.infer<typeof workflowSchema>;

// ─── Macro form ───────────────────────────────────────────────────────────────

const macroSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  isShared: z.boolean().optional(),
  categoryId: z.coerce.number().nullable().optional(),
  replyText: z.string().optional(),
  actions: z.array(actionSchema),
});
type MacroFormValues = z.infer<typeof macroSchema>;

// ─── Macro category form ─────────────────────────────────────────────────────

const macroCategorySchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
});
type MacroCategoryFormValues = z.infer<typeof macroCategorySchema>;

// ─── Action type options ─────────────────────────────────────────────────────

const ACTION_TYPES = [
  { value: 'assign_group', label: 'Назначить группу' },
  { value: 'assign_staff', label: 'Назначить сотрудника' },
  { value: 'set_status', label: 'Установить статус' },
  { value: 'set_priority', label: 'Установить приоритет' },
  { value: 'add_tag', label: 'Добавить тег' },
  { value: 'remove_tag', label: 'Удалить тег' },
  { value: 'send_email', label: 'Отправить email' },
];

// Actions that use a picker instead of free-text
const ACTION_WITH_STATUS = new Set(['set_status']);
const ACTION_WITH_PRIORITY = new Set(['set_priority']);
const ACTION_WITH_STAFF = new Set(['assign_staff']);

const CRITERION_OPS = [
  { value: 'is', label: 'равно' },
  { value: 'is_not', label: 'не равно' },
  { value: 'contains', label: 'содержит' },
  { value: 'not_contains', label: 'не содержит' },
  { value: 'starts_with', label: 'начинается с' },
  { value: 'ends_with', label: 'заканчивается на' },
];

const CRITERION_FIELDS = [
  { value: 'subject', label: 'Тема' },
  { value: 'statusId', label: 'Статус' },
  { value: 'priorityId', label: 'Приоритет' },
  { value: 'departmentId', label: 'Отдел' },
  { value: 'typeId', label: 'Тип' },
  { value: 'ownerStaffId', label: 'Исполнитель' },
  { value: 'requesterEmail', label: 'Email заявителя' },
  { value: 'creationMode', label: 'Канал (WEB/EMAIL/API/STAFF/ALARIS)' },
  { value: 'flagType', label: 'Флаг' },
  { value: 'isResolved', label: 'Решена (true/false)' },
  { value: 'isEscalated', label: 'Эскалирована (true/false)' },
];

// Fields that use a picker for value
const CRITERION_FIELD_STATUS = 'statusId';
const CRITERION_FIELD_PRIORITY = 'priorityId';
const CRITERION_FIELD_DEPARTMENT = 'departmentId';
const CRITERION_FIELD_STAFF = 'ownerStaffId';

// Macro action vocabulary
const MACRO_ACTION_TYPES = [
  { value: 'set_status', label: 'Установить статус' },
  { value: 'set_priority', label: 'Установить приоритет' },
  { value: 'assign', label: 'Назначить исполнителя' },
  { value: 'change_department', label: 'Сменить отдел' },
  { value: 'add_tag', label: 'Добавить тег (имя)' },
  { value: 'add_note', label: 'Добавить заметку (текст)' },
];

const MACRO_ACTION_WITH_STATUS = new Set(['set_status']);
const MACRO_ACTION_WITH_PRIORITY = new Set(['set_priority']);
const MACRO_ACTION_WITH_STAFF = new Set(['assign']);
const MACRO_ACTION_WITH_DEPT = new Set(['change_department']);

// ─── Pickers helper ──────────────────────────────────────────────────────────

function usePickerData() {
  const { data: statuses = [] } = useAdminStatuses();
  const { data: priorities = [] } = useAdminPriorities();
  const { data: depts = [] } = useAdminDepartments();
  const { data: staffData } = useAdminStaff();
  const staffList = staffData?.data ?? [];
  return { statuses, priorities, depts, staffList };
}

// Flatten department tree for picker
interface FlatDept {
  id: number;
  title: string;
  depth: number;
}
interface DeptNode {
  id: number;
  title: string;
  children?: DeptNode[];
}
function flattenDepts(tree: DeptNode[], depth = 0): FlatDept[] {
  const out: FlatDept[] = [];
  for (const d of tree) {
    out.push({ id: d.id, title: d.title, depth });
    if (d.children?.length) out.push(...flattenDepts(d.children, depth + 1));
  }
  return out;
}

// ─── Value picker for workflow/macro actions ──────────────────────────────────

function ActionValuePicker({
  actionType,
  value,
  onChange,
  macroMode,
}: {
  actionType: string;
  value: string;
  onChange: (v: string) => void;
  macroMode: boolean;
}) {
  const { statuses, priorities, depts, staffList } = usePickerData();
  const flatDepts = flattenDepts(depts);

  if (ACTION_WITH_STATUS.has(actionType) || (macroMode && MACRO_ACTION_WITH_STATUS.has(actionType))) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Выберите статус —</option>
        {statuses.map((s) => (
          <option key={s.id} value={String(s.id)}>
            {s.title}
          </option>
        ))}
      </select>
    );
  }

  if (ACTION_WITH_PRIORITY.has(actionType) || (macroMode && MACRO_ACTION_WITH_PRIORITY.has(actionType))) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Выберите приоритет —</option>
        {priorities.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.title}
          </option>
        ))}
      </select>
    );
  }

  if (ACTION_WITH_STAFF.has(actionType) || (macroMode && MACRO_ACTION_WITH_STAFF.has(actionType))) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Выберите сотрудника —</option>
        {staffList.map((s) => (
          <option key={s.id} value={String(s.id)}>
            {s.fullName}
          </option>
        ))}
      </select>
    );
  }

  if (macroMode && MACRO_ACTION_WITH_DEPT.has(actionType)) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Выберите отдел —</option>
        {flatDepts.map((d) => (
          <option key={d.id} value={String(d.id)}>
            {' '.repeat(d.depth * 2)}
            {d.title}
          </option>
        ))}
      </select>
    );
  }

  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Значение"
      className="flex-1"
    />
  );
}

// ─── Criterion value picker ───────────────────────────────────────────────────

function CriterionValuePicker({
  field,
  value,
  onChange,
}: {
  field: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const { statuses, priorities, depts, staffList } = usePickerData();
  const flatDepts = flattenDepts(depts);

  if (field === CRITERION_FIELD_STATUS) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Статус —</option>
        {statuses.map((s) => (
          <option key={s.id} value={String(s.id)}>
            {s.title}
          </option>
        ))}
      </select>
    );
  }
  if (field === CRITERION_FIELD_PRIORITY) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Приоритет —</option>
        {priorities.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.title}
          </option>
        ))}
      </select>
    );
  }
  if (field === CRITERION_FIELD_DEPARTMENT) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Отдел —</option>
        {flatDepts.map((d) => (
          <option key={d.id} value={String(d.id)}>
            {' '.repeat(d.depth * 2)}
            {d.title}
          </option>
        ))}
      </select>
    );
  }
  if (field === CRITERION_FIELD_STAFF) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
      >
        <option value="">— Сотрудник —</option>
        {staffList.map((s) => (
          <option key={s.id} value={String(s.id)}>
            {s.fullName}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Значение"
      className="flex-1"
    />
  );
}

// ─── Rename macro category dialog ─────────────────────────────────────────────

function RenameCategoryDialog({
  cat,
  open,
  onClose,
}: {
  cat: AdminMacroCategory;
  open: boolean;
  onClose: () => void;
}) {
  const updateCat = useUpdateMacroCategory();
  const form = useForm<MacroCategoryFormValues>({
    resolver: zodResolver(macroCategorySchema),
    defaultValues: { title: cat.title },
  });

  async function onSubmit(values: MacroCategoryFormValues) {
    try {
      await updateCat.mutateAsync({ id: cat.id, data: values });
      toast({ title: 'Категория переименована' });
      onClose();
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось переименовать', variant: 'destructive' });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Переименовать категорию</DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Название</label>
            <Input {...form.register('title')} />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={updateCat.isPending}>
              {updateCat.isPending ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowsContent() {
  const { data: workflows = [], isLoading: loadingWorkflows } = useAdminWorkflows();
  const { data: macros = [], isLoading: loadingMacros } = useAdminMacros();
  const { data: macroCategories = [] } = useAdminMacroCategories();

  const createWorkflow = useCreateWorkflow();
  const updateWorkflow = useUpdateWorkflow();
  const deleteWorkflow = useDeleteWorkflow();

  const createMacro = useCreateMacro();
  const updateMacro = useUpdateMacro();
  const deleteMacro = useDeleteMacro();

  const createMacroCategory = useCreateMacroCategory();
  const deleteMacroCategory = useDeleteMacroCategory();

  const [wfDialog, setWfDialog] = useState(false);
  const [editingWf, setEditingWf] = useState<AdminWorkflow | null>(null);

  const [macroDialog, setMacroDialog] = useState(false);
  const [editingMacro, setEditingMacro] = useState<AdminMacro | null>(null);

  const [renameCatTarget, setRenameCatTarget] = useState<AdminMacroCategory | null>(null);

  const wfForm = useForm<WorkflowFormValues>({
    resolver: zodResolver(workflowSchema),
    defaultValues: { title: '', isEnabled: true, sortOrder: 0, criteria: [], actions: [] },
  });

  const {
    fields: criteriaFields,
    append: appendCriterion,
    remove: removeCriterion,
  } = useFieldArray({ control: wfForm.control, name: 'criteria' });

  const {
    fields: actionsFields,
    append: appendAction,
    remove: removeAction,
  } = useFieldArray({ control: wfForm.control, name: 'actions' });

  const macroForm = useForm<MacroFormValues>({
    resolver: zodResolver(macroSchema),
    defaultValues: { title: '', isShared: true, categoryId: null, replyText: '', actions: [] },
  });

  const {
    fields: macroActionsFields,
    append: appendMacroAction,
    remove: removeMacroAction,
  } = useFieldArray({ control: macroForm.control, name: 'actions' });

  const macroCategoryForm = useForm<MacroCategoryFormValues>({
    resolver: zodResolver(macroCategorySchema),
    defaultValues: { title: '' },
  });

  function openCreateWf() {
    setEditingWf(null);
    wfForm.reset({ title: '', isEnabled: true, sortOrder: 0, criteria: [], actions: [] });
    setWfDialog(true);
  }

  function openEditWf(wf: AdminWorkflow) {
    setEditingWf(wf);
    const criteria = (wf.criteria as { field?: string; op?: string; value?: string }[]).map((c) => ({
      field: c.field ?? '',
      op: c.op ?? 'is',
      value: c.value ?? '',
    }));
    const actions = (wf.actions as { type?: string; value?: string; [k: string]: unknown }[]).map((a) => ({
      type: a.type ?? '',
      value:
        (a.value as string | undefined) ??
        Object.entries(a)
          .filter(([k]) => k !== 'type')
          .map(([, v]) => String(v ?? ''))
          .join(''),
    }));
    wfForm.reset({ title: wf.title, isEnabled: wf.isEnabled, sortOrder: wf.sortOrder, criteria, actions });
    setWfDialog(true);
  }

  async function onWfSubmit(values: WorkflowFormValues) {
    try {
      const criteria = values.criteria.map((c) => ({ field: c.field, op: c.op, value: c.value }));
      const actions = values.actions.map((a) => ({ type: a.type, value: a.value }));
      if (editingWf) {
        await updateWorkflow.mutateAsync({ id: editingWf.id, data: { ...values, criteria, actions } });
        toast({ title: 'Правило обновлено' });
      } else {
        await createWorkflow.mutateAsync({ ...values, criteria, actions });
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

  async function toggleWfEnabled(wf: AdminWorkflow) {
    try {
      await updateWorkflow.mutateAsync({ id: wf.id, data: { title: wf.title, isEnabled: !wf.isEnabled } });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось изменить статус', variant: 'destructive' });
    }
  }

  function openCreateMacro() {
    setEditingMacro(null);
    macroForm.reset({ title: '', isShared: true, categoryId: null, replyText: '', actions: [] });
    setMacroDialog(true);
  }

  function openEditMacro(macro: AdminMacro) {
    setEditingMacro(macro);
    const actions = (macro.actions as { type?: string; value?: string; [k: string]: unknown }[]).map((a) => ({
      type: a.type ?? '',
      value:
        (a.value as string | undefined) ??
        Object.entries(a)
          .filter(([k]) => k !== 'type')
          .map(([, v]) => String(v ?? ''))
          .join(''),
    }));
    macroForm.reset({
      title: macro.title,
      isShared: macro.isShared,
      categoryId: macro.categoryId,
      replyText: macro.replyText ?? '',
      actions,
    });
    setMacroDialog(true);
  }

  async function onMacroSubmit(values: MacroFormValues) {
    const actions = values.actions.map((a) => ({ type: a.type, value: a.value }));
    const payload = {
      ...values,
      isShared: values.isShared ?? false,
      replyText: values.replyText || null,
      actions,
    };
    try {
      if (editingMacro) {
        await updateMacro.mutateAsync({ id: editingMacro.id, data: payload });
        toast({ title: 'Макрос обновлён' });
      } else {
        await createMacro.mutateAsync(payload);
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

  async function onMacroCategorySubmit(values: MacroCategoryFormValues) {
    try {
      await createMacroCategory.mutateAsync(values);
      macroCategoryForm.reset({ title: '' });
      toast({ title: 'Категория создана' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось создать категорию', variant: 'destructive' });
    }
  }

  async function handleDeleteMacroCategory(id: number, title: string) {
    if (!confirm(`Удалить категорию «${title}»?`)) return;
    try {
      await deleteMacroCategory.mutateAsync(id);
      toast({ title: 'Категория удалена' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить категорию', variant: 'destructive' });
    }
  }

  // Watch form values for pickers
  const wfActionsWatch = wfForm.watch('actions');
  const macroActionsWatch = macroForm.watch('actions');
  const criteriaWatch = wfForm.watch('criteria');

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
                  <TableHead>Условия</TableHead>
                  <TableHead>Действий</TableHead>
                  <TableHead>Статус</TableHead>
                  <TableHead className="w-28">Управление</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.map((wf) => (
                  <TableRow key={wf.id}>
                    <TableCell className="font-medium">{wf.title}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{wf.sortOrder}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {(wf.criteria as unknown[]).length} шт.
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {(wf.actions as unknown[]).length} шт.
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => toggleWfEnabled(wf)}
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium cursor-pointer transition-colors ${
                          wf.isEnabled
                            ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 hover:bg-green-200'
                            : 'bg-muted text-muted-foreground hover:bg-muted/80'
                        }`}
                        title="Нажмите для переключения"
                      >
                        {wf.isEnabled ? 'Активно' : 'Выключено'}
                      </button>
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

      {/* Macro categories */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Категории макросов</h2>
        <form
          onSubmit={macroCategoryForm.handleSubmit(onMacroCategorySubmit)}
          className="flex items-end gap-2"
        >
          <div className="flex-1 space-y-1.5">
            <label className="text-sm font-medium">Новая категория</label>
            <Input {...macroCategoryForm.register('title')} placeholder="Название категории" />
            {macroCategoryForm.formState.errors.title && (
              <p className="text-xs text-destructive">{macroCategoryForm.formState.errors.title.message}</p>
            )}
          </div>
          <Button type="submit" size="sm" disabled={createMacroCategory.isPending}>
            <Plus className="mr-1.5 h-4 w-4" />
            Добавить
          </Button>
        </form>

        {macroCategories.length > 0 && (
          <div className="rounded-xl border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Название</TableHead>
                  <TableHead className="w-24">Действия</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {macroCategories.map((cat) => (
                  <TableRow key={cat.id}>
                    <TableCell className="font-medium">{cat.title}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setRenameCatTarget(cat)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDeleteMacroCategory(cat.id, cat.title)}
                          disabled={deleteMacroCategory.isPending}
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
                  <TableHead className="w-20">Действия</TableHead>
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
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => openEditMacro(m)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => handleDeleteMacro(m)}
                            disabled={deleteMacro.isPending}
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
        )}
      </section>

      {/* Workflow dialog */}
      <Dialog open={wfDialog} onOpenChange={setWfDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingWf ? 'Редактировать правило' : 'Новое правило'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={wfForm.handleSubmit(onWfSubmit)} className="space-y-5">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...wfForm.register('title')} placeholder="Название правила" />
              {wfForm.formState.errors.title && (
                <p className="text-xs text-destructive">{wfForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex items-center gap-2">
                <input type="checkbox" id="wfEnabled" {...wfForm.register('isEnabled')} />
                <label htmlFor="wfEnabled" className="text-sm">
                  Активно
                </label>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Порядок</label>
                <Input type="number" min={0} {...wfForm.register('sortOrder')} className="h-8" />
              </div>
            </div>

            {/* Criteria builder */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Условия (criteria)</label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => appendCriterion({ field: 'subject', op: 'contains', value: '' })}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Добавить условие
                </Button>
              </div>
              {criteriaFields.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Нет условий — правило применяется ко всем заявкам
                </p>
              )}
              {criteriaFields.map((field, idx) => {
                const fieldVal = criteriaWatch[idx]?.field ?? '';
                const known = !fieldVal || CRITERION_FIELDS.some((f) => f.value === fieldVal);
                return (
                  <div key={field.id} className="space-y-1">
                    <div className="flex gap-2 items-start">
                      <select
                        {...wfForm.register(`criteria.${idx}.field`)}
                        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
                      >
                        {!known && <option value={fieldVal}>{`(unknown: ${fieldVal})`}</option>}
                        {CRITERION_FIELDS.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <select
                        {...wfForm.register(`criteria.${idx}.op`)}
                        className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
                      >
                        {CRITERION_OPS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <CriterionValuePicker
                        field={fieldVal}
                        value={criteriaWatch[idx]?.value ?? ''}
                        onChange={(v) => wfForm.setValue(`criteria.${idx}.value`, v)}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-destructive hover:text-destructive shrink-0"
                        onClick={() => removeCriterion(idx)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {!known && (
                      <p className="text-xs text-amber-600">
                        Поле «{fieldVal}» не из стандартного списка. Выберите поле заново, чтобы исправить.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Actions builder */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Действия (actions)</label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => appendAction({ type: 'add_tag', value: '' })}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Добавить действие
                </Button>
              </div>
              {actionsFields.length === 0 && <p className="text-xs text-muted-foreground">Нет действий</p>}
              {actionsFields.map((field, idx) => (
                <div key={field.id} className="flex gap-2 items-start">
                  <select
                    {...wfForm.register(`actions.${idx}.type`)}
                    className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <ActionValuePicker
                    actionType={wfActionsWatch[idx]?.type ?? ''}
                    value={wfActionsWatch[idx]?.value ?? ''}
                    onChange={(v) => wfForm.setValue(`actions.${idx}.value`, v)}
                    macroMode={false}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-destructive hover:text-destructive shrink-0"
                    onClick={() => removeAction(idx)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
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
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingMacro ? 'Редактировать макрос' : 'Новый макрос'}</DialogTitle>
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
              <input type="checkbox" id="macroShared" {...macroForm.register('isShared')} />
              <label htmlFor="macroShared" className="text-sm">
                Общий (виден всем агентам)
              </label>
            </div>

            {/* Reply text */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Текст ответа (replyText)</label>
              <textarea
                {...macroForm.register('replyText')}
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm resize-y"
                placeholder="Текст, который будет вставлен в ответ при применении макроса"
              />
            </div>

            {/* Macro actions builder */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Действия</label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => appendMacroAction({ type: 'set_status', value: '' })}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Добавить действие
                </Button>
              </div>
              {macroActionsFields.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Нет действий — макрос ничего не изменит (можно использовать только для текста ответа)
                </p>
              )}
              {macroActionsFields.map((field, idx) => (
                <div key={field.id} className="flex gap-2 items-start">
                  <select
                    {...macroForm.register(`actions.${idx}.type`)}
                    className="h-9 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1"
                  >
                    {MACRO_ACTION_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                  <ActionValuePicker
                    actionType={macroActionsWatch[idx]?.type ?? ''}
                    value={macroActionsWatch[idx]?.value ?? ''}
                    onChange={(v) => macroForm.setValue(`actions.${idx}.value`, v)}
                    macroMode={true}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-destructive hover:text-destructive shrink-0"
                    onClick={() => removeMacroAction(idx)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMacroDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createMacro.isPending || updateMacro.isPending}>
                {createMacro.isPending || updateMacro.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename category dialog */}
      {renameCatTarget && (
        <RenameCategoryDialog cat={renameCatTarget} open={true} onClose={() => setRenameCatTarget(null)} />
      )}
    </div>
  );
}
