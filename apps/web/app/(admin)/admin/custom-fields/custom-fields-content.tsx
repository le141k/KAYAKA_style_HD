'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminCustomFieldGroups,
  useCreateCustomFieldGroup,
  useUpdateCustomFieldGroup,
  useDeleteCustomFieldGroup,
  useCreateCustomField,
  useUpdateCustomField,
  useDeleteCustomField,
  type AdminCustomFieldGroup,
  type AdminCustomField,
} from '@/lib/hooks/use-admin';

const SCOPE_OPTIONS = [
  { value: 'TICKET', label: 'Заявка (Ticket)' },
  { value: 'USER', label: 'Пользователь (User)' },
  { value: 'STAFF', label: 'Сотрудник (Staff)' },
  { value: 'ORGANIZATION', label: 'Организация (Organization)' },
] as const;

const groupSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  scope: z.enum(['TICKET', 'USER', 'STAFF', 'ORGANIZATION']).default('TICKET'),
});
type GroupFormValues = z.infer<typeof groupSchema>;

const FIELD_TYPES = [
  { value: 'text', label: 'Текст' },
  { value: 'textarea', label: 'Многострочный текст' },
  { value: 'password', label: 'Пароль' },
  { value: 'checkbox', label: 'Чекбокс' },
  { value: 'radio', label: 'Радио-кнопки' },
  { value: 'select', label: 'Список (select)' },
  { value: 'multiselect', label: 'Мультивыбор' },
  { value: 'date', label: 'Дата' },
  { value: 'number', label: 'Число' },
  { value: 'file', label: 'Файл' },
  { value: 'custom', label: 'Произвольный' },
];

const OPTIONS_TYPES = ['select', 'radio', 'multiselect'];

const fieldSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  type: z.string().min(1, 'Обязательное поле'),
  isRequired: z.boolean().optional(),
  isEncrypted: z.boolean().optional(),
  options: z.string().optional(), // newline-separated
});
type FieldFormValues = z.infer<typeof fieldSchema>;

function parseOptions(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function FieldDialog({
  groupId,
  groupTitle,
  editing,
  open,
  onClose,
}: {
  groupId: number;
  groupTitle: string;
  editing: AdminCustomField | null;
  open: boolean;
  onClose: () => void;
}) {
  const createField = useCreateCustomField(groupId);
  const updateField = useUpdateCustomField();

  const form = useForm<FieldFormValues>({
    resolver: zodResolver(fieldSchema),
    defaultValues: {
      title: editing?.title ?? '',
      type: editing?.type?.toLowerCase() ?? 'text',
      isRequired: editing?.isRequired ?? false,
      isEncrypted: editing?.isEncrypted ?? false,
      options: editing?.options?.join('\n') ?? '',
    },
  });

  // reset when editing changes
  const watchedType = form.watch('type');
  const showOptions = OPTIONS_TYPES.includes(watchedType);

  async function onSubmit(values: FieldFormValues) {
    const options = parseOptions(values.options);
    try {
      if (editing) {
        await updateField.mutateAsync({
          id: editing.id,
          data: {
            title: values.title,
            type: values.type,
            isRequired: values.isRequired,
            isEncrypted: values.isEncrypted,
            options: showOptions ? options : [],
          },
        });
        toast({ title: 'Поле обновлено' });
      } else {
        await createField.mutateAsync({
          title: values.title,
          type: values.type,
          isRequired: values.isRequired,
          isEncrypted: values.isEncrypted,
          options: showOptions ? options : [],
        });
        toast({ title: 'Поле добавлено' });
      }
      onClose();
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить поле', variant: 'destructive' });
    }
  }

  const isBusy = createField.isPending || updateField.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? `Редактировать поле — ${groupTitle}` : `Новое поле — ${groupTitle}`}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Название</label>
            <Input {...form.register('title')} placeholder="Название поля" />
            {form.formState.errors.title && (
              <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Тип</label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
              {...form.register('type')}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {showOptions && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Варианты (по одному на строку)</label>
              <textarea
                {...form.register('options')}
                rows={4}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm resize-y"
                placeholder="Вариант 1&#10;Вариант 2&#10;Вариант 3"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <input type="checkbox" id="isRequired" {...form.register('isRequired')} />
            <label htmlFor="isRequired" className="text-sm">
              Обязательное поле
            </label>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="isEncrypted" {...form.register('isEncrypted')} />
            <label htmlFor="isEncrypted" className="text-sm">
              Шифровать значение
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Отмена
            </Button>
            <Button type="submit" disabled={isBusy}>
              {isBusy ? 'Сохранение…' : editing ? 'Обновить' : 'Добавить'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupRow({
  group,
  onDeleteGroup,
  onDeleteField,
}: {
  group: AdminCustomFieldGroup;
  onDeleteGroup: (id: number) => void;
  onDeleteField: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fieldDialog, setFieldDialog] = useState(false);
  const [editingField, setEditingField] = useState<AdminCustomField | null>(null);

  const [groupEditOpen, setGroupEditOpen] = useState(false);
  const updateGroup = useUpdateCustomFieldGroup();

  const groupForm = useForm<GroupFormValues>({
    resolver: zodResolver(groupSchema),
    defaultValues: { title: group.title, scope: group.scope },
  });

  async function onGroupEdit(values: GroupFormValues) {
    try {
      await updateGroup.mutateAsync({ id: group.id, data: values });
      toast({ title: 'Группа обновлена' });
      setGroupEditOpen(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось обновить группу', variant: 'destructive' });
    }
  }

  function openCreateField() {
    setEditingField(null);
    setFieldDialog(true);
  }

  function openEditField(field: AdminCustomField) {
    setEditingField(field);
    setFieldDialog(true);
  }

  const scopeLabel = SCOPE_OPTIONS.find((s) => s.value === group.scope)?.label ?? group.scope;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium hover:text-primary"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {group.title}
          <span className="ml-1 text-xs text-muted-foreground">({group.fields.length} полей)</span>
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{scopeLabel}</span>
        </button>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={openCreateField}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Добавить поле
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => {
              groupForm.reset({ title: group.title, scope: group.scope });
              setGroupEditOpen(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={() => onDeleteGroup(group.id)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && group.fields.length > 0 && (
        <div className="border-t border-border">
          {group.fields.map((field) => (
            <div
              key={field.id}
              className="flex items-center justify-between px-6 py-2 text-sm border-b border-border last:border-0"
            >
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{field.title}</span>
                <span className="text-xs text-muted-foreground bg-muted rounded px-1 py-0.5">
                  {FIELD_TYPES.find((t) => t.value === field.type.toLowerCase())?.label ?? field.type}
                </span>
                {field.isRequired && <span className="text-xs text-destructive">Обязательное</span>}
                {field.isEncrypted && (
                  <span className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 rounded px-1 py-0.5">
                    Зашифровано
                  </span>
                )}
                {field.options.length > 0 && (
                  <span className="text-xs text-muted-foreground">{field.options.length} вар.</span>
                )}
              </div>
              <div className="flex gap-1">
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => openEditField(field)}>
                  <Pencil className="h-3 w-3" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-destructive hover:text-destructive"
                  onClick={() => onDeleteField(field.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {expanded && group.fields.length === 0 && (
        <div className="border-t border-border px-6 py-4 text-sm text-muted-foreground">
          Полей нет. Нажмите «Добавить поле».
        </div>
      )}

      {/* Field create/edit dialog */}
      <FieldDialog
        groupId={group.id}
        groupTitle={group.title}
        editing={editingField}
        open={fieldDialog}
        onClose={() => setFieldDialog(false)}
      />

      {/* Group edit dialog */}
      <Dialog open={groupEditOpen} onOpenChange={setGroupEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Редактировать группу</DialogTitle>
          </DialogHeader>
          <form onSubmit={groupForm.handleSubmit(onGroupEdit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...groupForm.register('title')} placeholder="Название группы" />
              {groupForm.formState.errors.title && (
                <p className="text-xs text-destructive">{groupForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Область (scope)</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                {...groupForm.register('scope')}
              >
                {SCOPE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setGroupEditOpen(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={updateGroup.isPending}>
                {updateGroup.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CustomFieldsContent() {
  const { data: groups = [], isLoading } = useAdminCustomFieldGroups();
  const createGroup = useCreateCustomFieldGroup();
  const deleteGroup = useDeleteCustomFieldGroup();
  const deleteField = useDeleteCustomField();

  const [groupDialog, setGroupDialog] = useState(false);
  const groupForm = useForm<GroupFormValues>({
    resolver: zodResolver(groupSchema),
    defaultValues: { title: '', scope: 'TICKET' },
  });

  async function onGroupSubmit(values: GroupFormValues) {
    try {
      await createGroup.mutateAsync(values);
      toast({ title: 'Группа создана' });
      setGroupDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось создать группу', variant: 'destructive' });
    }
  }

  async function handleDeleteGroup(id: number) {
    if (!confirm('Удалить группу полей?')) return;
    try {
      await deleteGroup.mutateAsync(id);
      toast({ title: 'Группа удалена' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить группу', variant: 'destructive' });
    }
  }

  async function handleDeleteField(id: number) {
    if (!confirm('Удалить поле?')) return;
    try {
      await deleteField.mutateAsync(id);
      toast({ title: 'Поле удалено' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить поле', variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Пользовательские поля</h1>
          <p className="text-sm text-muted-foreground">Расширение форм дополнительными полями</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            groupForm.reset({ title: '', scope: 'TICKET' });
            setGroupDialog(true);
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Добавить группу
        </Button>
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Загрузка…</p>}

      {!isLoading && groups.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <p className="text-sm font-medium text-muted-foreground">Групп полей нет</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Добавьте группу и поля для сбора дополнительной информации
          </p>
        </div>
      )}

      <div className="space-y-3">
        {groups.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            onDeleteGroup={handleDeleteGroup}
            onDeleteField={handleDeleteField}
          />
        ))}
      </div>

      <Dialog open={groupDialog} onOpenChange={setGroupDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новая группа полей</DialogTitle>
          </DialogHeader>
          <form onSubmit={groupForm.handleSubmit(onGroupSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название группы</label>
              <Input {...groupForm.register('title')} placeholder="Например: Техническая информация" />
              {groupForm.formState.errors.title && (
                <p className="text-xs text-destructive">{groupForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Область (scope)</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                {...groupForm.register('scope')}
              >
                {SCOPE_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setGroupDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createGroup.isPending}>
                {createGroup.isPending ? 'Создание…' : 'Создать'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
