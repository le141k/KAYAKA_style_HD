'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import {
  useAdminDepartments,
  useCreateDepartment,
  useUpdateDepartment,
  useDeleteDepartment,
  type AdminDepartment,
} from '@/lib/hooks/use-admin';

const schema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  parentId: z.number().nullable().optional(),
});
type FormValues = z.infer<typeof schema>;

function flattenDepts(depts: AdminDepartment[], depth = 0): { dept: AdminDepartment; depth: number }[] {
  const out: { dept: AdminDepartment; depth: number }[] = [];
  for (const d of depts) {
    out.push({ dept: d, depth });
    if (d.children.length > 0) out.push(...flattenDepts(d.children, depth + 1));
  }
  return out;
}

export function DepartmentsContent() {
  const { data: tree = [], isLoading } = useAdminDepartments();
  const createMut = useCreateDepartment();
  const updateMut = useUpdateDepartment();
  const deleteMut = useDeleteDepartment();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminDepartment | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { title: '', parentId: null },
  });

  function openCreate() {
    setEditing(null);
    form.reset({ title: '', parentId: null });
    setDialogOpen(true);
  }

  function openEdit(dept: AdminDepartment) {
    setEditing(dept);
    form.reset({ title: dept.title, parentId: dept.parentId ?? null });
    setDialogOpen(true);
  }

  async function onSubmit(values: FormValues) {
    try {
      if (editing) {
        await updateMut.mutateAsync({ id: editing.id, data: values });
        toast({ title: 'Отдел обновлён' });
      } else {
        await createMut.mutateAsync(values);
        toast({ title: 'Отдел создан' });
      }
      setDialogOpen(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить отдел', variant: 'destructive' });
    }
  }

  async function handleDelete(dept: AdminDepartment) {
    if (!confirm(`Удалить отдел «${dept.title}»?`)) return;
    try {
      await deleteMut.mutateAsync(dept.id);
      toast({ title: 'Отдел удалён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось удалить отдел', variant: 'destructive' });
    }
  }

  const flat = flattenDepts(tree);
  const isBusy = createMut.isPending || updateMut.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Отделы</h1>
          <p className="text-sm text-muted-foreground">Управление отделами и иерархией</p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Добавить отдел
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Название</TableHead>
              <TableHead>Тип</TableHead>
              <TableHead className="w-20">Действия</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                  Загрузка…
                </TableCell>
              </TableRow>
            )}
            {!isLoading && flat.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="text-center text-muted-foreground py-8">
                  Нет отделов
                </TableCell>
              </TableRow>
            )}
            {flat.map(({ dept, depth }) => (
              <TableRow key={dept.id}>
                <TableCell className="font-medium">
                  <span style={{ paddingLeft: depth * 20 }} className="flex items-center gap-1">
                    {depth > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                    {dept.title}
                  </span>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{dept.type}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(dept)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive hover:text-destructive"
                      onClick={() => handleDelete(dept)}
                      disabled={deleteMut.isPending}
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Редактировать отдел' : 'Новый отдел'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...form.register('title')} placeholder="Название отдела" />
              {form.formState.errors.title && (
                <p className="text-xs text-destructive">{form.formState.errors.title.message}</p>
              )}
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
