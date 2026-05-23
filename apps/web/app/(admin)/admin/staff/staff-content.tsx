'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { getInitials } from '@/lib/utils';
import {
  useAdminStaff,
  useCreateStaff,
  useUpdateStaff,
  useAdminStaffGroups,
  type AdminStaffMember,
} from '@/lib/hooks/use-admin';

const staffSchema = z.object({
  email: z.string().email('Некорректный email'),
  firstName: z.string().min(1, 'Обязательное поле'),
  lastName: z.string().min(1, 'Обязательное поле'),
  username: z.string().optional(),
  designation: z.string().optional(),
  // Group is mandatory: the API requires a positive staffGroupId on create.
  staffGroupId: z.coerce.number({ invalid_type_error: 'Выберите группу' }).int().positive('Выберите группу'),
  password: z.string().optional(),
});
type StaffFormValues = z.infer<typeof staffSchema>;

export function StaffContent() {
  const { data, isLoading } = useAdminStaff();
  const { data: groups = [] } = useAdminStaffGroups();
  const createStaff = useCreateStaff();
  const updateStaff = useUpdateStaff();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminStaffMember | null>(null);

  const form = useForm<StaffFormValues>({
    resolver: zodResolver(staffSchema),
    defaultValues: {
      email: '',
      firstName: '',
      lastName: '',
      designation: '',
      staffGroupId: undefined,
      password: '',
    },
  });

  const staffList = data?.data ?? [];

  function openCreate() {
    setEditing(null);
    form.reset({
      email: '',
      firstName: '',
      lastName: '',
      designation: '',
      staffGroupId: undefined,
      password: '',
    });
    setDialogOpen(true);
  }

  function openEdit(member: AdminStaffMember) {
    setEditing(member);
    form.reset({
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      username: member.username,
      designation: member.designation,
      staffGroupId: member.staffGroupId ?? undefined,
      password: '',
    });
    setDialogOpen(true);
  }

  async function onSubmit(values: StaffFormValues) {
    const payload = { ...values };
    if (!payload.password) delete payload.password;
    try {
      if (editing) {
        await updateStaff.mutateAsync({ id: editing.id, data: payload });
        toast({ title: 'Сотрудник обновлён' });
      } else {
        if (!values.password) {
          form.setError('password', { message: 'Пароль обязателен при создании' });
          return;
        }
        await createStaff.mutateAsync(payload);
        toast({ title: 'Сотрудник создан' });
      }
      setDialogOpen(false);
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось сохранить сотрудника', variant: 'destructive' });
    }
  }

  const isBusy = createStaff.isPending || updateStaff.isPending;

  function groupName(id: number | null) {
    if (!id) return '—';
    return groups.find((g) => g.id === id)?.title ?? String(id);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Сотрудники и группы</h1>
          <p className="text-sm text-muted-foreground">Управление агентами, ролями и группами</p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Добавить сотрудника
        </Button>
      </div>

      <div className="rounded-xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Сотрудник</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Должность</TableHead>
              <TableHead>Группа</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead className="w-16">Действия</TableHead>
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
            {!isLoading && staffList.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  Нет сотрудников
                </TableCell>
              </TableRow>
            )}
            {staffList.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar className="h-7 w-7">
                      <AvatarFallback className="text-xs">{getInitials(member.fullName)}</AvatarFallback>
                    </Avatar>
                    <span className="font-medium text-sm">{member.fullName}</span>
                  </div>
                </TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">{member.email}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{member.designation || '—'}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{groupName(member.staffGroupId)}</Badge>
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      member.isEnabled
                        ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                        : 'bg-muted text-muted-foreground'
                    }`}
                  >
                    {member.isEnabled ? 'Активен' : 'Заблок.'}
                  </span>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(member)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? 'Редактировать сотрудника' : 'Новый сотрудник'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Имя</label>
                <Input {...form.register('firstName')} placeholder="Имя" />
                {form.formState.errors.firstName && (
                  <p className="text-xs text-destructive">{form.formState.errors.firstName.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Фамилия</label>
                <Input {...form.register('lastName')} placeholder="Фамилия" />
                {form.formState.errors.lastName && (
                  <p className="text-xs text-destructive">{form.formState.errors.lastName.message}</p>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Email</label>
              <Input type="email" {...form.register('email')} placeholder="email@example.com" />
              {form.formState.errors.email && (
                <p className="text-xs text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Должность</label>
              <Input {...form.register('designation')} placeholder="Должность" />
            </div>
            {groups.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Группа</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  {...form.register('staffGroupId')}
                >
                  <option value="">— Выберите группу —</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
                {form.formState.errors.staffGroupId && (
                  <p className="text-xs text-destructive">{form.formState.errors.staffGroupId.message}</p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                {editing ? 'Новый пароль (оставьте пустым, чтобы не менять)' : 'Пароль'}
              </label>
              <Input type="password" {...form.register('password')} placeholder="••••••••" />
              {form.formState.errors.password && (
                <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
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
