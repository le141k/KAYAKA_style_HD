'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2, Tag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminTicketTypes,
  useCreateTicketType,
  useUpdateTicketType,
  useDeleteTicketType,
  type AdminTicketType,
} from '@/lib/hooks/use-admin';

const typeSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  displayOrder: z.coerce.number().int().optional(),
  displayIcon: z.string().optional(),
});
type TypeFormValues = z.infer<typeof typeSchema>;

export function TicketTypesContent() {
  const { data: types = [], isLoading } = useAdminTicketTypes();
  const createType = useCreateTicketType();
  const updateType = useUpdateTicketType();
  const deleteType = useDeleteTicketType();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminTicketType | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const form = useForm<TypeFormValues>({
    resolver: zodResolver(typeSchema),
    defaultValues: { title: '', displayOrder: 0, displayIcon: '' },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ title: '', displayOrder: 0, displayIcon: '' });
    setDialogOpen(true);
  }

  function openEdit(t: AdminTicketType) {
    setEditing(t);
    form.reset({ title: t.title, displayOrder: t.displayOrder, displayIcon: t.displayIcon });
    setDialogOpen(true);
  }

  async function onSubmit(values: TypeFormValues) {
    try {
      if (editing) {
        await updateType.mutateAsync({ id: editing.id, data: values });
        toast({ title: 'Тип обновлён' });
      } else {
        await createType.mutateAsync(values);
        toast({ title: 'Тип создан' });
      }
      setDialogOpen(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить тип', variant: 'destructive' });
    }
  }

  async function handleDelete(t: AdminTicketType) {
    if (!confirm(`Удалить тип «${t.title}»?`)) return;
    setDeleteError(null);
    try {
      await deleteType.mutateAsync(t.id);
      toast({ title: 'Тип удалён' });
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        setDeleteError(
          `Нельзя удалить тип «${t.title}» — он используется в заявках. Сначала переназначьте заявки на другой тип.`,
        );
      } else {
        toast({ title: 'Ошибка', description: 'Не удалось удалить тип', variant: 'destructive' });
      }
    }
  }

  const isBusy = createType.isPending || updateType.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Типы заявок</h1>
          <p className="text-sm text-muted-foreground">Классификация заявок по типу</p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Добавить тип
        </Button>
      </div>

      {deleteError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {deleteError}
          <Button
            variant="ghost"
            size="sm"
            className="ml-2 h-5 px-2 text-xs"
            onClick={() => setDeleteError(null)}
          >
            ✕
          </Button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка…</p>
      ) : types.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center">
          <Tag className="mx-auto mb-3 h-8 w-8 text-muted-foreground opacity-40" />
          <p className="text-sm font-medium">Типов заявок нет</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Создайте типы для классификации входящих заявок
          </p>
          <Button className="mt-4" size="sm" variant="outline" onClick={openCreate}>
            <Plus className="mr-1.5 h-4 w-4" />
            Создать первый тип
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Иконка</TableHead>
                <TableHead>Название</TableHead>
                <TableHead>Порядок</TableHead>
                <TableHead className="w-20">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="text-lg">
                    {t.displayIcon ? (
                      <span title={t.displayIcon}>{t.displayIcon}</span>
                    ) : (
                      <Tag className="h-4 w-4 text-muted-foreground" />
                    )}
                  </TableCell>
                  <TableCell className="font-medium">{t.title}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{t.displayOrder}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(t)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(t)}
                        disabled={deleteType.isPending}
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Редактировать тип' : 'Новый тип заявки'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...form.register('title')} placeholder="Например: Инцидент" />
              {form.formState.errors.title && (
                <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Порядок отображения</label>
              <Input type="number" min={0} {...form.register('displayOrder')} className="h-8" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Иконка (emoji или CSS-класс)</label>
              <Input {...form.register('displayIcon')} placeholder="🎫 или icon-name" />
              <p className="text-xs text-muted-foreground">
                Необязательно. Используйте emoji или имя иконки вашей иконочной библиотеки.
              </p>
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
