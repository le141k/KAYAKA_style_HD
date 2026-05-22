'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminCustomFieldGroups,
  useCreateCustomFieldGroup,
  useDeleteCustomFieldGroup,
  useCreateCustomField,
  useDeleteCustomField,
  type AdminCustomFieldGroup,
} from '@/lib/hooks/use-admin';

const groupSchema = z.object({ title: z.string().min(1, 'Обязательное поле') });
type GroupFormValues = z.infer<typeof groupSchema>;

const FIELD_TYPES = [
  { value: 'text', label: 'Текст' },
  { value: 'textarea', label: 'Многострочный текст' },
  { value: 'select', label: 'Список (select)' },
  { value: 'checkbox', label: 'Чекбокс' },
  { value: 'date', label: 'Дата' },
  { value: 'number', label: 'Число' },
];

const fieldSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  type: z.string().min(1, 'Обязательное поле'),
  isRequired: z.boolean().optional(),
});
type FieldFormValues = z.infer<typeof fieldSchema>;

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
  const createField = useCreateCustomField(group.id);

  const fieldForm = useForm<FieldFormValues>({
    resolver: zodResolver(fieldSchema),
    defaultValues: { title: '', type: 'text', isRequired: false },
  });

  async function onFieldSubmit(values: FieldFormValues) {
    try {
      await createField.mutateAsync(values);
      toast({ title: 'Поле добавлено' });
      setFieldDialog(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось добавить поле', variant: 'destructive' });
    }
  }

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
        </button>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setFieldDialog(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Добавить поле
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
              <div>
                <span className="font-medium">{field.title}</span>
                <span className="ml-2 text-xs text-muted-foreground bg-muted rounded px-1 py-0.5">
                  {FIELD_TYPES.find((t) => t.value === field.type)?.label ?? field.type}
                </span>
                {field.isRequired && <span className="ml-2 text-xs text-destructive">Обязательное</span>}
              </div>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6 text-destructive hover:text-destructive"
                onClick={() => onDeleteField(field.id)}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {expanded && group.fields.length === 0 && (
        <div className="border-t border-border px-6 py-4 text-sm text-muted-foreground">
          Полей нет. Нажмите «Добавить поле».
        </div>
      )}

      <Dialog open={fieldDialog} onOpenChange={setFieldDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новое поле — {group.title}</DialogTitle>
          </DialogHeader>
          <form onSubmit={fieldForm.handleSubmit(onFieldSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...fieldForm.register('title')} placeholder="Название поля" />
              {fieldForm.formState.errors.title && (
                <p className="text-xs text-destructive">{fieldForm.formState.errors.title.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Тип</label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                {...fieldForm.register('type')}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="isRequired" {...fieldForm.register('isRequired')} />
              <label htmlFor="isRequired" className="text-sm">
                Обязательное поле
              </label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFieldDialog(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createField.isPending}>
                {createField.isPending ? 'Сохранение…' : 'Добавить'}
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
    defaultValues: { title: '' },
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
          <p className="text-sm text-muted-foreground">Расширение формы заявки дополнительными полями</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            groupForm.reset({ title: '' });
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
            Добавьте группу и поля для сбора дополнительной информации от клиентов
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
