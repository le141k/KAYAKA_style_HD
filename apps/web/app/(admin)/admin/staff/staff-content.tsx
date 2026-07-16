'use client';

import { useEffect, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Pencil, Trash2, UserX, History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from '@/components/ui/use-toast';
import { getInitials } from '@/lib/utils';
import { ApiError } from '@/lib/api';
import {
  useAdminStaff,
  useCreateStaff,
  useUpdateStaff,
  useDisableStaff,
  useAdminStaffGroups,
  useCreateStaffGroup,
  useUpdateStaffGroup,
  useDeleteStaffGroup,
  useRbacCatalog,
  useRbacAudit,
  type AdminStaffMember,
  type AdminStaffGroup,
  type RbacPermissionMeta,
} from '@/lib/hooks/use-admin';

// Fallback permission catalog — used only if GET /staff/rbac hasn't loaded yet.
// The backend catalog (useRbacCatalog) is the source of truth.
const FALLBACK_PERMISSIONS: RbacPermissionMeta[] = [
  { key: 'ticket.view', label: 'Просмотр заявок', category: 'tickets' },
  { key: 'ticket.create', label: 'Создание заявок', category: 'tickets' },
  { key: 'ticket.reply', label: 'Ответ на заявки', category: 'tickets' },
  { key: 'ticket.edit', label: 'Редактирование заявок', category: 'tickets' },
  { key: 'ticket.assign', label: 'Назначение заявок', category: 'tickets' },
  { key: 'ticket.delete', label: 'Удаление заявок', category: 'tickets' },
  { key: 'ticket.merge', label: 'Слияние заявок', category: 'tickets' },
  { key: 'ticket.note', label: 'Заметки', category: 'tickets' },
  { key: 'kb.view', label: 'База знаний: просмотр', category: 'knowledgebase' },
  { key: 'kb.manage', label: 'База знаний: управление', category: 'knowledgebase' },
  { key: 'news.manage', label: 'Новости: управление', category: 'news' },
  { key: 'user.manage', label: 'Управление пользователями', category: 'people' },
  { key: 'staff.manage', label: 'Управление сотрудниками', category: 'people' },
  { key: 'org.manage', label: 'Управление организациями', category: 'people' },
  { key: 'org.delete', label: 'Удаление организаций', category: 'people' },
  { key: 'report.run', label: 'Запуск отчётов', category: 'reports' },
  { key: 'report.manage', label: 'Управление отчётами', category: 'reports' },
  { key: 'admin.settings', label: 'Настройки (статусы, приоритеты…)', category: 'admin' },
  { key: 'admin.sla', label: 'SLA', category: 'admin' },
  { key: 'admin.workflow', label: 'Правила и макросы', category: 'admin' },
  { key: 'admin.mail', label: 'Email-интеграция', category: 'admin' },
  { key: 'admin.departments', label: 'Отделы', category: 'admin' },
  { key: 'admin.customfields', label: 'Пользовательские поля', category: 'admin' },
  { key: 'admin.alaris', label: 'Интеграция Alaris', category: 'admin' },
];

const CATEGORY_LABELS: Record<string, string> = {
  tickets: 'Заявки',
  knowledgebase: 'База знаний',
  news: 'Новости',
  people: 'Люди',
  reports: 'Отчёты',
  admin: 'Администрирование',
};

const ACTION_LABELS: Record<string, string> = {
  'staff.create': 'Создан сотрудник',
  'staff.update': 'Изменён сотрудник',
  'staff.role_change': 'Смена роли',
  'staff.password_reset': 'Смена пароля',
  'staff.enable': 'Аккаунт включён',
  'staff.disable': 'Аккаунт отключён',
  'group.create': 'Создана группа',
  'group.update': 'Изменена группа',
  'group.permissions_change': 'Изменены права группы',
  'group.delete': 'Удалена группа',
};

/** Pull a human-readable message from an API error body (e.g. last-admin 403). */
function serverMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const data = err.data as { message?: string | string[] } | undefined;
    if (data?.message) return Array.isArray(data.message) ? data.message.join(', ') : data.message;
  }
  return fallback;
}

const staffSchema = z.object({
  email: z.string().email('Некорректный email'),
  firstName: z.string().min(1, 'Обязательное поле'),
  lastName: z.string().min(1, 'Обязательное поле'),
  username: z.string().optional(),
  designation: z.string().optional(),
  staffGroupId: z.coerce.number({ invalid_type_error: 'Выберите группу' }).int().positive('Выберите группу'),
  // Empty = "no change" (edit) / prompted separately (create); any supplied
  // password must be ≥ 8 chars, matching the API rule.
  password: z.union([z.string().min(8, 'Минимум 8 символов'), z.literal('')]).optional(),
  isEnabled: z.boolean().optional(),
});
type StaffFormValues = z.infer<typeof staffSchema>;

const groupSchema = z.object({
  title: z.string().min(1, 'Обязательное поле'),
  isAdmin: z.boolean().optional(),
});
type GroupFormValues = z.infer<typeof groupSchema>;

// ─── Staff groups section ─────────────────────────────────────────────────────

function StaffGroupsSection() {
  const { data: groups = [], isLoading } = useAdminStaffGroups();
  const { data: catalog } = useRbacCatalog();
  const createGroup = useCreateStaffGroup();
  const updateGroup = useUpdateStaffGroup();
  const deleteGroup = useDeleteStaffGroup();

  const permissionCatalog = catalog?.permissions ?? FALLBACK_PERMISSIONS;
  const roleTemplates = catalog?.roles ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [templateKey, setTemplateKey] = useState<string>('');
  const [editingGroup, setEditingGroup] = useState<AdminStaffGroup | null>(null);
  const [permissionsGroup, setPermissionsGroup] = useState<AdminStaffGroup | null>(null);
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);

  const createForm = useForm<GroupFormValues>({
    resolver: zodResolver(groupSchema),
    defaultValues: { title: '', isAdmin: false },
  });

  const editForm = useForm<GroupFormValues>({
    resolver: zodResolver(groupSchema),
    defaultValues: { title: '', isAdmin: false },
  });

  const activeTemplate = roleTemplates.find((r) => r.key === templateKey);

  function openCreate() {
    setTemplateKey('');
    createForm.reset({ title: '', isAdmin: false });
    setCreateOpen(true);
  }

  function onTemplateChange(key: string) {
    setTemplateKey(key);
    const tpl = roleTemplates.find((r) => r.key === key);
    if (tpl && !createForm.getValues('title')) createForm.setValue('title', tpl.title);
    if (tpl) createForm.setValue('isAdmin', tpl.isAdmin);
  }

  async function onCreateSubmit(values: GroupFormValues) {
    try {
      const payload = activeTemplate
        ? { title: values.title, isAdmin: activeTemplate.isAdmin, permissions: activeTemplate.permissions }
        : { title: values.title, isAdmin: values.isAdmin ?? false, permissions: [] };
      await createGroup.mutateAsync(payload);
      toast({ title: 'Группа создана' });
      setCreateOpen(false);
      setTemplateKey('');
      createForm.reset({ title: '', isAdmin: false });
    } catch (err) {
      toast({
        title: 'Ошибка',
        description: serverMessage(err, 'Не удалось создать группу'),
        variant: 'destructive',
      });
    }
  }

  function openEdit(g: AdminStaffGroup) {
    setEditingGroup(g);
    editForm.reset({ title: g.title, isAdmin: g.isAdmin });
  }

  async function onEditSubmit(values: GroupFormValues) {
    if (!editingGroup) return;
    try {
      await updateGroup.mutateAsync({ id: editingGroup.id, data: { title: values.title } });
      toast({ title: 'Группа переименована' });
      setEditingGroup(null);
    } catch (err) {
      toast({
        title: 'Ошибка',
        description: serverMessage(err, 'Не удалось обновить группу'),
        variant: 'destructive',
      });
    }
  }

  async function handleDelete(g: AdminStaffGroup) {
    if (!confirm(`Удалить группу «${g.title}»?`)) return;
    try {
      await deleteGroup.mutateAsync(g.id);
      toast({ title: 'Группа удалена' });
    } catch (err: unknown) {
      const status = err instanceof ApiError ? err.status : undefined;
      const fallback =
        status === 409
          ? 'Нельзя удалить — группа используется сотрудниками'
          : status === 403
            ? 'Нельзя удалить последнюю группу администраторов'
            : 'Не удалось удалить группу';
      toast({ title: 'Ошибка', description: serverMessage(err, fallback), variant: 'destructive' });
    }
  }

  function openPermissions(g: AdminStaffGroup) {
    setPermissionsGroup(g);
    setSelectedPerms(g.permissions);
  }

  async function savePermissions() {
    if (!permissionsGroup) return;
    try {
      await updateGroup.mutateAsync({ id: permissionsGroup.id, data: { permissions: selectedPerms } });
      toast({ title: 'Права обновлены', description: 'Активные сессии участников группы завершены.' });
      setPermissionsGroup(null);
    } catch (err) {
      toast({
        title: 'Ошибка',
        description: serverMessage(err, 'Не удалось сохранить права'),
        variant: 'destructive',
      });
    }
  }

  function togglePerm(key: string) {
    setSelectedPerms((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  // Group the catalog by category for the permissions dialog.
  const permsByCategory = useMemo(() => {
    const map = new Map<string, RbacPermissionMeta[]>();
    for (const p of permissionCatalog) {
      const list = map.get(p.category) ?? [];
      list.push(p);
      map.set(p.category, list);
    }
    return Array.from(map.entries());
  }, [permissionCatalog]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Группы сотрудников</h2>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 h-4 w-4" />
          Создать группу
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Загрузка…</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Групп нет</p>
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Название</TableHead>
                <TableHead>Администратор</TableHead>
                <TableHead>Прав</TableHead>
                <TableHead className="w-32">Действия</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="font-medium">{g.title}</TableCell>
                  <TableCell className="text-sm">
                    {g.isAdmin ? (
                      <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
                        Да
                      </span>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {g.isAdmin ? 'все' : g.permissions.length}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => openPermissions(g)}
                      >
                        Права
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(g)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(g)}
                        disabled={deleteGroup.isPending}
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

      {/* Create group dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Новая группа сотрудников</DialogTitle>
          </DialogHeader>
          <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4">
            {roleTemplates.length > 0 && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Шаблон роли</label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={templateKey}
                  onChange={(e) => onTemplateChange(e.target.value)}
                >
                  <option value="">Пустая матрица (настроить вручную)</option>
                  {roleTemplates.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.title}
                    </option>
                  ))}
                </select>
                {activeTemplate && (
                  <p className="text-xs text-muted-foreground">
                    {activeTemplate.description}{' '}
                    <span className="font-medium">
                      (
                      {activeTemplate.isAdmin ? 'полный доступ' : `${activeTemplate.permissions.length} прав`}
                      )
                    </span>
                  </p>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...createForm.register('title')} placeholder="Название группы" />
              {createForm.formState.errors.title && (
                <p className="text-xs text-destructive">{createForm.formState.errors.title.message}</p>
              )}
            </div>
            {!activeTemplate && (
              <div className="flex items-center gap-2">
                <input type="checkbox" id="groupIsAdmin" {...createForm.register('isAdmin')} />
                <label htmlFor="groupIsAdmin" className="text-sm">
                  Группа администраторов
                </label>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {activeTemplate
                ? 'Права из шаблона можно скорректировать позже через кнопку «Права».'
                : 'После создания группы настройте права через кнопку «Права» в таблице.'}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Отмена
              </Button>
              <Button type="submit" disabled={createGroup.isPending}>
                {createGroup.isPending ? 'Создание…' : 'Создать'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rename group dialog */}
      <Dialog open={!!editingGroup} onOpenChange={(v) => !v && setEditingGroup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переименовать группу</DialogTitle>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Название</label>
              <Input {...editForm.register('title')} />
              {editForm.formState.errors.title && (
                <p className="text-xs text-destructive">{editForm.formState.errors.title.message}</p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingGroup(null)}>
                Отмена
              </Button>
              <Button type="submit" disabled={updateGroup.isPending}>
                {updateGroup.isPending ? 'Сохранение…' : 'Сохранить'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Permissions dialog */}
      <Dialog open={!!permissionsGroup} onOpenChange={(v) => !v && setPermissionsGroup(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Права группы «{permissionsGroup?.title}»</DialogTitle>
          </DialogHeader>
          {permissionsGroup?.isAdmin && (
            <p className="rounded-md bg-amber-100 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
              Группа администраторов обходит проверки отдельных прав — доступен весь функционал.
            </p>
          )}
          <div className="space-y-3 py-2">
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSelectedPerms(permissionCatalog.map((p) => p.key))}
              >
                Выбрать все
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setSelectedPerms([])}>
                Снять все
              </Button>
            </div>
            {permsByCategory.map(([category, perms]) => (
              <div key={category} className="space-y-1.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {CATEGORY_LABELS[category] ?? category}
                </p>
                {perms.map((p) => (
                  <div key={p.key} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id={`perm-${p.key}`}
                      checked={selectedPerms.includes(p.key)}
                      onChange={() => togglePerm(p.key)}
                    />
                    <label htmlFor={`perm-${p.key}`} className="text-sm">
                      <span className="font-mono text-xs text-muted-foreground mr-2">{p.key}</span>
                      {p.label}
                    </label>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPermissionsGroup(null)}>
              Отмена
            </Button>
            <Button onClick={savePermissions} disabled={updateGroup.isPending}>
              {updateGroup.isPending ? 'Сохранение…' : 'Сохранить'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// ─── RBAC audit section ─────────────────────────────────────────────────────

function RbacAuditSection() {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useRbacAudit({ limit: 50, enabled: open });
  const entries = data?.data ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <History className="h-4 w-4" /> Журнал изменений (аудит)
        </h2>
        <Button size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? 'Скрыть' : 'Показать'}
        </Button>
      </div>

      {open && (
        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">Время</TableHead>
                <TableHead>Кто</TableHead>
                <TableHead>Действие</TableHead>
                <TableHead>Объект</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Загрузка…
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Записей нет
                  </TableCell>
                </TableRow>
              )}
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString('ru-RU')}
                  </TableCell>
                  <TableCell className="text-sm">{e.actorEmail || '—'}</TableCell>
                  <TableCell className="text-sm">
                    <Badge variant="secondary">{ACTION_LABELS[e.action] ?? e.action}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {e.targetLabel || `${e.targetType}#${e.targetId ?? '?'}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

// ─── Main staff content ───────────────────────────────────────────────────────

export function StaffContent() {
  const { data: groups = [] } = useAdminStaffGroups();

  // Filters (search / status / group). Search is debounced so we don't refetch
  // on every keystroke.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');
  const [groupFilter, setGroupFilter] = useState<number>(0);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data, isLoading } = useAdminStaff({
    search: search || undefined,
    groupId: groupFilter || undefined,
    enabled: statusFilter === 'all' ? undefined : statusFilter === 'active',
  });
  const createStaff = useCreateStaff();
  const updateStaff = useUpdateStaff();
  const disableStaff = useDisableStaff();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AdminStaffMember | null>(null);

  const defaultGroupId = useMemo(() => groups.find((g) => g.title === 'Agent')?.id, [groups]);

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
  const selectedGroupId = form.watch('staffGroupId');
  const selectedGroup = groups.find((g) => g.id === Number(selectedGroupId));

  function openCreate() {
    setEditing(null);
    form.reset({
      email: '',
      firstName: '',
      lastName: '',
      designation: '',
      // Default new staff to the Agent role (least privilege) when it exists.
      staffGroupId: defaultGroupId,
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
      isEnabled: member.isEnabled,
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
        const { isEnabled: _ie, ...createPayload } = payload;
        void _ie;
        await createStaff.mutateAsync(createPayload);
        toast({ title: 'Сотрудник создан' });
      }
      setDialogOpen(false);
    } catch (err) {
      toast({
        title: 'Ошибка',
        description: serverMessage(err, 'Не удалось сохранить сотрудника'),
        variant: 'destructive',
      });
    }
  }

  async function handleDisable(member: AdminStaffMember) {
    if (!confirm(`Отключить доступ для «${member.fullName}»? Сотрудник не сможет войти.`)) return;
    try {
      await disableStaff.mutateAsync(member.id);
      toast({ title: 'Доступ отключён', description: 'Активные сессии сотрудника завершены.' });
    } catch (err) {
      toast({
        title: 'Ошибка',
        description: serverMessage(err, 'Не удалось отключить сотрудника'),
        variant: 'destructive',
      });
    }
  }

  const isBusy = createStaff.isPending || updateStaff.isPending;

  function groupName(id: number | null) {
    if (!id) return '—';
    return groups.find((g) => g.id === id)?.title ?? String(id);
  }

  return (
    <div className="space-y-8">
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

      {/* Staff groups section */}
      <StaffGroupsSection />

      {/* Staff members table */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Сотрудники</h2>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Поиск по имени или email…"
            className="h-9 w-64"
          />
          <select
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            value={groupFilter}
            onChange={(e) => setGroupFilter(Number(e.target.value))}
            aria-label="Фильтр по группе"
          >
            <option value={0}>Все роли</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
          <select
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'disabled')}
            aria-label="Фильтр по статусу"
          >
            <option value="all">Все статусы</option>
            <option value="active">Активные</option>
            <option value="disabled">Заблокированные</option>
          </select>
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
                <TableHead className="w-24">Действия</TableHead>
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
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEdit(member)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {member.isEnabled && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-amber-600 hover:text-amber-700"
                          title="Отключить доступ"
                          onClick={() => handleDisable(member)}
                          disabled={disableStaff.isPending}
                        >
                          <UserX className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {/* RBAC audit log */}
      <RbacAuditSection />

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
                <label className="text-sm font-medium">Роль / группа</label>
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
                {selectedGroup && (
                  <p className="text-xs text-muted-foreground">
                    Доступ:{' '}
                    <span className="font-medium">
                      {selectedGroup.isAdmin
                        ? 'полный (администратор)'
                        : `${selectedGroup.permissions.length} прав`}
                    </span>
                  </p>
                )}
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
              <p className="text-xs text-muted-foreground">Минимум 8 символов.</p>
              {form.formState.errors.password && (
                <p className="text-xs text-destructive">{form.formState.errors.password.message}</p>
              )}
            </div>
            {editing && (
              <div className="flex items-center gap-3">
                <input
                  id="isEnabled"
                  type="checkbox"
                  className="h-4 w-4 rounded border-input accent-primary"
                  {...form.register('isEnabled')}
                />
                <label htmlFor="isEnabled" className="text-sm font-medium cursor-pointer">
                  Аккаунт активен
                </label>
              </div>
            )}
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
