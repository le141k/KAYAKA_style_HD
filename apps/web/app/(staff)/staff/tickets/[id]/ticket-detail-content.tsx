'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, Lock, Send, Loader2, Paperclip } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import {
  useTicket,
  useReply,
  useUpdateTicket,
  useStaffOptions,
  useTicketTags,
  useDepartmentOptions,
  useChangeTicketDepartment,
  useApplyMacro,
  useMacroOptions,
} from '@/lib/hooks/use-tickets';
import type { Ticket, Attachment } from '@/lib/types';
import { StatusBadge } from '@/components/premium/StatusBadge';
import { PriorityChip } from '@/components/premium/PriorityChip';
import { SlaPill } from '@/components/premium/SlaPill';
import { FileUploadZone } from '@/components/premium/FileUploadZone';
import { TicketDetailSkeleton } from '@/components/premium/SkeletonLoaders';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { Combobox } from '@/components/ui/combobox';
import { cn, formatDate, getInitials } from '@/lib/utils';
import { RelativeTime } from '@/components/RelativeTime';
import { TimeTrackingPanel } from '@/components/tickets/TimeTrackingPanel';
import { FollowUpsPanel } from '@/components/tickets/FollowUpsPanel';
import { toast } from '@/components/ui/use-toast';

const STATUS_OPTIONS: { value: Ticket['status']; label: string }[] = [
  { value: 'open', label: 'Открыта' },
  { value: 'pending', label: 'Ожидает' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'resolved', label: 'Решена' },
  { value: 'closed', label: 'Закрыта' },
];
const PRIORITY_OPTIONS: { value: Ticket['priority']; label: string }[] = [
  { value: 'urgent', label: 'Критический' },
  { value: 'high', label: 'Высокий' },
  { value: 'normal', label: 'Обычный' },
  { value: 'low', label: 'Низкий' },
];

const replySchema = z.object({
  body: z.string().min(1, 'Введите текст ответа'),
});
type ReplyForm = z.infer<typeof replySchema>;

export function TicketDetailContent({ ticketId }: { ticketId: number }) {
  const { data: ticket, isLoading: ticketLoading } = useTicket(ticketId);
  const replyMutation = useReply(ticketId);
  const updateTicket = useUpdateTicket(ticketId);
  const { data: staffOptions = [] } = useStaffOptions();
  const { data: departmentOptions = [] } = useDepartmentOptions();
  const { data: macroOptions = [] } = useMacroOptions();
  const changeDepartment = useChangeTicketDepartment(ticketId);
  const applyMacro = useApplyMacro(ticketId);
  const tags = useTicketTags(ticketId);
  const [newTag, setNewTag] = useState('');

  const [replyTab, setReplyTab] = useState<'reply' | 'note'>('reply');
  const [attachmentIds, setAttachmentIds] = useState<number[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [departmentId, setDepartmentId] = useState<string>('');

  // Sync the assignee picker once the ticket loads (it starts undefined).
  useEffect(() => {
    if (ticket?.assignee) setAssigneeId(String(ticket.assignee.id));
  }, [ticket?.assignee]);
  // Sync the department picker once the ticket loads.
  useEffect(() => {
    if (ticket?.department) setDepartmentId(String(ticket.department.id));
  }, [ticket?.department]);

  const handleChangeDepartment = async (v: string) => {
    if (!v) return;
    setDepartmentId(v);
    try {
      await changeDepartment.mutateAsync(Number(v));
      const dept = departmentOptions.find((o) => o.value === v);
      toast({ title: dept ? `Отдел: ${dept.label}` : 'Отдел изменён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось изменить отдел', variant: 'destructive' });
    }
  };

  const handleApplyMacro = async (v: string) => {
    if (!v) return;
    try {
      await applyMacro.mutateAsync(Number(v));
      const macro = macroOptions.find((o) => o.value === v);
      toast({ title: macro ? `Макрос применён: ${macro.label}` : 'Макрос применён' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось применить макрос', variant: 'destructive' });
    }
  };

  const changeStatus = async (status: Ticket['status']) => {
    try {
      await updateTicket.mutateAsync({ status });
      toast({ title: `Статус: ${STATUS_OPTIONS.find((s) => s.value === status)?.label ?? status}` });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось изменить статус', variant: 'destructive' });
    }
  };
  const changePriority = async (priority: Ticket['priority']) => {
    try {
      await updateTicket.mutateAsync({ priority });
      toast({ title: `Приоритет: ${PRIORITY_OPTIONS.find((p) => p.value === priority)?.label ?? priority}` });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось изменить приоритет', variant: 'destructive' });
    }
  };
  const changeAssignee = async (v: string) => {
    setAssigneeId(v);
    try {
      await updateTicket.mutateAsync({ assigneeId: v ? Number(v) : null });
      const agent = staffOptions.find((o) => o.value === v);
      toast({ title: agent ? `Назначено: ${agent.label}` : 'Исполнитель снят' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось назначить исполнителя', variant: 'destructive' });
    }
  };

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<ReplyForm>({
    resolver: zodResolver(replySchema),
  });

  // ── Reply draft auto-save ──
  // Persist the in-progress reply per ticket so navigating away (or an accidental
  // reload) doesn't lose it. Cleared on successful send.
  const draftKey = `th_reply_draft_${ticketId}`;
  const [draftRestored, setDraftRestored] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || draftRestored) return;
    const saved = localStorage.getItem(draftKey);
    if (saved) setValue('body', saved);
    setDraftRestored(true);
  }, [draftKey, draftRestored, setValue]);
  const draftBody = watch('body');
  useEffect(() => {
    if (typeof window === 'undefined' || !draftRestored) return;
    if (draftBody && draftBody.trim() !== '') localStorage.setItem(draftKey, draftBody);
    else localStorage.removeItem(draftKey);
  }, [draftBody, draftKey, draftRestored]);

  // r hotkey → focus reply
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
    if (e.key === 'r') {
      document.getElementById('reply-textarea')?.focus();
      e.preventDefault();
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const onSubmit = async (data: ReplyForm) => {
    await replyMutation.mutateAsync({
      body: data.body,
      is_internal: replyTab === 'note',
      attachmentIds,
    });
    reset();
    setAttachmentIds([]);
    if (typeof window !== 'undefined') localStorage.removeItem(draftKey);
    toast({
      title: replyTab === 'note' ? 'Заметка добавлена' : 'Ответ отправлен',
    });
  };

  if (ticketLoading)
    return (
      <div className="p-6">
        <TicketDetailSkeleton />
      </div>
    );
  if (!ticket) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Заявка не найдена</p>
      </div>
    );
  }

  const allReplies = ticket.replies ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border bg-card px-6 py-3">
        <Button variant="ghost" size="icon" asChild className="h-8 w-8">
          <Link href="/staff/tickets">
            <ArrowLeft className="h-4 w-4" />
            <span className="sr-only">Назад</span>
          </Link>
        </Button>
        <code className="font-mono text-sm text-muted-foreground">{ticket.mask}</code>
        <StatusBadge status={ticket.status} pulse={ticket.status === 'open'} />
        <PriorityChip priority={ticket.priority} />
        <SlaPill dueAt={ticket.sla_due_at} />
        <h1 className="ml-2 flex-1 truncate text-base font-semibold">{ticket.subject}</h1>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Main thread */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Conversation */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {/* Original message */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-xl border border-border bg-card p-5"
            >
              <div className="mb-3 flex items-center gap-3">
                <Avatar className="h-8 w-8">
                  <AvatarFallback>{getInitials(ticket.requester.name)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-semibold">{ticket.requester.name}</p>
                  <p className="text-xs text-muted-foreground">{formatDate(ticket.created_at)}</p>
                </div>
              </div>
              <p className="text-sm leading-relaxed whitespace-pre-line">{ticket.body}</p>
            </motion.div>

            {/* Replies */}
            {allReplies.map((reply, i) => (
              <motion.div
                key={reply.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className={cn(
                  'rounded-xl border p-5',
                  reply.is_internal
                    ? 'border-status-pending/30 bg-status-pending/5'
                    : 'border-border bg-card',
                )}
              >
                <div className="mb-3 flex items-center gap-3">
                  <Avatar className="h-7 w-7">
                    <AvatarImage src={reply.author.avatar_url} />
                    <AvatarFallback className="text-xs">{getInitials(reply.author.name)}</AvatarFallback>
                  </Avatar>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-semibold">{reply.author.name}</p>
                      {reply.is_internal && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-status-pending/10 px-2 py-0.5 text-[10px] font-semibold text-status-pending">
                          <Lock className="h-2.5 w-2.5" />
                          Внутренняя
                        </span>
                      )}
                    </div>
                    <RelativeTime className="text-xs text-muted-foreground" date={reply.created_at} />
                  </div>
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-line">{reply.body}</p>
                {reply.attachments && reply.attachments.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {reply.attachments.map((att: Attachment) => (
                      <a
                        key={att.id}
                        href={att.url}
                        download={att.filename}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        <Paperclip className="h-2.5 w-2.5" />
                        {att.filename}
                      </a>
                    ))}
                  </div>
                )}
              </motion.div>
            ))}
          </div>

          {/* Reply composer */}
          <div className="border-t border-border bg-card p-4">
            <Tabs value={replyTab} onValueChange={(v) => setReplyTab(v as typeof replyTab)}>
              <TabsList className="mb-3">
                <TabsTrigger value="reply">Ответ</TabsTrigger>
                <TabsTrigger value="note">Внутренняя заметка</TabsTrigger>
              </TabsList>
              <form onSubmit={handleSubmit(onSubmit)}>
                <TabsContent value="reply">
                  <Textarea
                    id="reply-textarea"
                    placeholder="Введите ответ клиенту... (R)"
                    className="min-h-[100px] resize-none"
                    {...register('body')}
                    aria-label="Текст ответа"
                  />
                </TabsContent>
                <TabsContent value="note">
                  <Textarea
                    id="note-textarea"
                    placeholder="Внутренняя заметка (видна только агентам)..."
                    className="min-h-[100px] resize-none border-status-pending/40 bg-status-pending/5"
                    {...register('body')}
                    aria-label="Внутренняя заметка"
                  />
                </TabsContent>
                {errors.body && <p className="mt-1 text-xs text-destructive">{errors.body.message}</p>}
                {draftBody && draftBody.trim() !== '' && (
                  <p className="mt-1 text-xs text-muted-foreground">Черновик сохраняется автоматически</p>
                )}

                <div className="mt-3 space-y-3">
                  <FileUploadZone
                    uploadEndpoint="/attachments/upload"
                    onUploaded={(ids) => setAttachmentIds((prev) => [...prev, ...ids])}
                    maxFiles={10}
                    className="text-sm"
                  />
                  <div className="flex justify-end">
                    <Button type="submit" disabled={replyMutation.isPending} className="gap-2">
                      {replyMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      {replyTab === 'note' ? 'Добавить заметку' : 'Отправить'}
                    </Button>
                  </div>
                </div>
              </form>
            </Tabs>
          </div>
        </div>

        {/* Side panel */}
        <aside className="hidden w-72 flex-shrink-0 overflow-y-auto border-l border-border bg-card/50 p-5 xl:block">
          <div className="space-y-5">
            {/* Properties */}
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Свойства
              </h3>
              <dl className="space-y-2.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Статус</dt>
                  <dd className="flex-1 max-w-[150px]">
                    <Combobox
                      options={STATUS_OPTIONS}
                      value={ticket.status}
                      onValueChange={(v) => void changeStatus(v as Ticket['status'])}
                      placeholder="Статус"
                      triggerWidth="w-full"
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Приоритет</dt>
                  <dd className="flex-1 max-w-[150px]">
                    <Combobox
                      options={PRIORITY_OPTIONS}
                      value={ticket.priority}
                      onValueChange={(v) => void changePriority(v as Ticket['priority'])}
                      placeholder="Приоритет"
                      triggerWidth="w-full"
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Отдел</dt>
                  <dd className="flex-1 max-w-[150px]">
                    <Combobox
                      options={departmentOptions}
                      value={departmentId}
                      onValueChange={(v) => void handleChangeDepartment(v)}
                      placeholder="Отдел"
                      searchPlaceholder="Поиск отдела..."
                      emptyMessage="Отдел не найден"
                      disabled={changeDepartment.isPending}
                      triggerWidth="w-full"
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">SLA</dt>
                  <dd>
                    <SlaPill dueAt={ticket.sla_due_at} />
                  </dd>
                </div>
              </dl>
            </section>

            <Separator />

            {/* Requester */}
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Заявитель
              </h3>
              <div className="flex items-center gap-2.5">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="text-xs">{getInitials(ticket.requester.name)}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="text-sm font-medium">{ticket.requester.name}</p>
                  <p className="text-xs text-muted-foreground">{ticket.requester.email}</p>
                </div>
              </div>
            </section>

            <Separator />
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Исполнитель
              </h3>
              <Combobox
                options={staffOptions}
                value={assigneeId}
                onValueChange={(v) => void changeAssignee(v)}
                placeholder="Назначить исполнителя"
                searchPlaceholder="Поиск агента..."
                emptyMessage="Агент не найден"
                triggerWidth="w-full"
              />
            </section>

            <Separator />

            {/* Macros */}
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Макрос
              </h3>
              <Combobox
                options={macroOptions}
                value=""
                onValueChange={(v) => void handleApplyMacro(v)}
                placeholder="Применить макрос"
                searchPlaceholder="Поиск макроса..."
                emptyMessage="Макросы не найдены"
                disabled={applyMacro.isPending}
                triggerWidth="w-full"
              />
            </section>

            <Separator />

            {/* Quick actions */}
            <section className="space-y-2">
              {ticket.status !== 'resolved' && ticket.status !== 'closed' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={updateTicket.isPending}
                  onClick={() => void changeStatus('resolved')}
                >
                  Решена
                </Button>
              )}
              {ticket.status !== 'closed' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={updateTicket.isPending}
                  onClick={() => void changeStatus('closed')}
                >
                  Закрыть
                </Button>
              )}
            </section>

            <Separator />

            {/* Dates */}
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Даты
              </h3>
              <dl className="space-y-2 text-xs">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Создана</dt>
                  <dd>{formatDate(ticket.created_at)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">Обновлена</dt>
                  <dd>{formatDate(ticket.updated_at)}</dd>
                </div>
              </dl>
            </section>

            {/* Tags */}
            <Separator />
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Метки
              </h3>
              <div className="mb-2 flex flex-wrap gap-1.5">
                {(ticket.tags ?? []).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {tag}
                    <button
                      type="button"
                      aria-label={`Удалить метку ${tag}`}
                      className="text-muted-foreground/60 hover:text-destructive"
                      onClick={() => tags.remove.mutate(tag)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                {(ticket.tags ?? []).length === 0 && (
                  <span className="text-xs text-muted-foreground">Нет меток</span>
                )}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const name = newTag.trim();
                  if (name) {
                    tags.add.mutate(name);
                    setNewTag('');
                  }
                }}
              >
                <input
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  placeholder="Добавить метку…"
                  className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-xs"
                  aria-label="Новая метка"
                />
              </form>
            </section>

            {/* Time tracking */}
            <Separator />
            <section>
              <TimeTrackingPanel ticketId={ticketId} />
            </section>

            {/* Follow-ups */}
            <Separator />
            <section>
              <FollowUpsPanel ticketId={ticketId} />
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
