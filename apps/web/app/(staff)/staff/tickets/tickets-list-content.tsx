'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Search, SlidersHorizontal, LayoutGrid, CalendarDays, X, Plus } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { DateRange } from 'react-day-picker';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { TicketRow } from '@/components/premium/TicketRow';
import { TicketListSkeleton } from '@/components/premium/SkeletonLoaders';
import { useTickets, useCreateTicket, useDepartmentOptions } from '@/lib/hooks/use-tickets';
import { useToast } from '@/components/ui/use-toast';
import { useI18n } from '@/lib/i18n';
import Link from 'next/link';

// ─── Create ticket form schema ───────────────────────────────────────────────
const createTicketSchema = z.object({
  subject: z.string().min(3, 'Тема должна содержать не менее 3 символов'),
  body: z.string().min(5, 'Текст должен содержать не менее 5 символов'),
  requesterEmail: z.string().email('Введите корректный email'),
  requesterName: z.string().optional(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).optional(),
  // API requires a department; coerce the select's string value to a positive id.
  department_id: z.coerce.number({ invalid_type_error: 'Выберите отдел' }).int().positive('Выберите отдел'),
});
type CreateTicketFormData = z.infer<typeof createTicketSchema>;

export function TicketsListContent() {
  const { t } = useI18n();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [priority, setPriority] = useState('all');
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Create dialog state — open when ?create=1 is present
  const [createOpen, setCreateOpen] = useState(() => searchParams.get('create') === '1');

  const createMutation = useCreateTicket();
  const { data: departmentOptions = [] } = useDepartmentOptions();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateTicketFormData>({
    resolver: zodResolver(createTicketSchema),
    defaultValues: { priority: 'normal' },
  });

  const openCreate = () => {
    reset({ priority: 'normal' });
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
    // Remove ?create=1 from URL without full reload
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete('create');
    const qs = params.toString();
    router.replace(`/staff/tickets${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  const onSubmitCreate = async (data: CreateTicketFormData) => {
    try {
      await createMutation.mutateAsync(data);
      toast({ title: 'Заявка создана', description: `Тема: ${data.subject}` });
      closeCreate();
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось создать заявку', variant: 'destructive' });
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data, isLoading } = useTickets({
    q: debouncedSearch || undefined,
    status: status === 'all' ? undefined : status,
    priority: priority === 'all' ? undefined : priority,
    date_from: dateRange?.from ? dateRange.from.toISOString() : undefined,
    date_to: dateRange?.to ? new Date(dateRange.to.getTime() + 86_399_000).toISOString() : undefined,
  });

  const tickets = useMemo(() => data?.data ?? [], [data]);

  // j/k keyboard nav
  const [focusedIdx, setFocusedIdx] = useState(-1);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA')
        return;
      if (e.key === 'j') {
        setFocusedIdx((i) => Math.min(i + 1, tickets.length - 1));
        e.preventDefault();
      } else if (e.key === 'k') {
        setFocusedIdx((i) => Math.max(i - 1, 0));
        e.preventDefault();
      } else if (e.key === 'Enter' && focusedIdx >= 0) {
        const t = tickets[focusedIdx];
        if (t) router.push(`/staff/tickets/${t.id}`);
      }
    },
    [tickets, focusedIdx, router],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <h1 className="mr-4 text-lg font-semibold">{t.nav.tickets}</h1>

        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t.common.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
            aria-label="Поиск заявок"
          />
        </div>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Статус" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все статусы</SelectItem>
            <SelectItem value="open">Открытые</SelectItem>
            <SelectItem value="pending">Ожидают</SelectItem>
            <SelectItem value="in_progress">В работе</SelectItem>
            <SelectItem value="resolved">Решённые</SelectItem>
            <SelectItem value="closed">Закрытые</SelectItem>
          </SelectContent>
        </Select>

        <Select value={priority} onValueChange={setPriority}>
          <SelectTrigger className="h-8 w-36 text-sm">
            <SelectValue placeholder="Приоритет" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все</SelectItem>
            <SelectItem value="urgent">Критический</SelectItem>
            <SelectItem value="high">Высокий</SelectItem>
            <SelectItem value="normal">Обычный</SelectItem>
            <SelectItem value="low">Низкий</SelectItem>
          </SelectContent>
        </Select>

        {/* Date range filter */}
        <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-sm font-normal"
              aria-label="Фильтр по дате"
            >
              <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
              {dateRange?.from ? (
                dateRange.to ? (
                  <span>
                    {format(dateRange.from, 'dd.MM', { locale: ru })}
                    {' — '}
                    {format(dateRange.to, 'dd.MM.yy', { locale: ru })}
                  </span>
                ) : (
                  <span>{format(dateRange.from, 'dd.MM.yy', { locale: ru })}</span>
                )
              ) : (
                <span className="text-muted-foreground">Период</span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar mode="range" selected={dateRange} onSelect={setDateRange} numberOfMonths={2} />
            {dateRange && (
              <div className="flex justify-end border-t border-border p-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs text-muted-foreground"
                  onClick={() => {
                    setDateRange(undefined);
                    setCalendarOpen(false);
                  }}
                >
                  <X className="h-3 w-3" />
                  Сбросить
                </Button>
              </div>
            )}
          </PopoverContent>
        </Popover>

        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={openCreate} className="h-8 gap-1.5">
            <Plus className="h-3.5 w-3.5" />
            Создать заявку
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/staff/kanban">
              <LayoutGrid className="mr-1.5 h-3.5 w-3.5" />
              Канбан
            </Link>
          </Button>
          <Button variant="outline" size="icon" className="h-8 w-8">
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span className="sr-only">Фильтры</span>
          </Button>
        </div>
      </div>

      {/* Results info */}
      <div className="px-6 py-2 text-xs text-muted-foreground border-b border-border">
        {isLoading ? 'Загрузка...' : `${data?.total ?? 0} заявок · j/k для навигации · Enter для открытия`}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <TicketListSkeleton count={8} />
        ) : tickets.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <SlidersHorizontal className="h-8 w-8 opacity-30" />
            <p>{t.common.noResults}</p>
          </div>
        ) : (
          <div className="space-y-2" role="list" aria-label="Список заявок">
            {tickets.map((ticket, i) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                href={`/staff/tickets/${ticket.id}`}
                selected={i === focusedIdx}
                onSelect={() => setFocusedIdx(i)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create Ticket Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) closeCreate();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Создать заявку</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit(onSubmitCreate)} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ct-subject">Тема *</Label>
              <Input id="ct-subject" placeholder="Краткое описание проблемы" {...register('subject')} />
              {errors.subject && <p className="text-xs text-destructive">{errors.subject.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ct-body">Сообщение *</Label>
              <Textarea id="ct-body" rows={4} placeholder="Подробное описание..." {...register('body')} />
              {errors.body && <p className="text-xs text-destructive">{errors.body.message}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ct-email">Email клиента *</Label>
              <Input
                id="ct-email"
                type="email"
                placeholder="client@example.com"
                {...register('requesterEmail')}
              />
              {errors.requesterEmail && (
                <p className="text-xs text-destructive">{errors.requesterEmail.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ct-name">Имя клиента</Label>
              <Input id="ct-name" placeholder="Иван Иванов" {...register('requesterName')} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ct-department">Отдел</Label>
              <select
                id="ct-department"
                {...register('department_id')}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">— Выберите отдел —</option>
                {departmentOptions.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              {errors.department_id && (
                <p className="text-xs text-destructive">{errors.department_id.message}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ct-priority">Приоритет</Label>
              <select
                id="ct-priority"
                {...register('priority')}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="normal">Обычный</option>
                <option value="low">Низкий</option>
                <option value="high">Высокий</option>
                <option value="urgent">Критический</option>
              </select>
            </div>

            <DialogFooter className="pt-2">
              <Button type="button" variant="outline" onClick={closeCreate}>
                Отмена
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Создание...' : 'Создать'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
