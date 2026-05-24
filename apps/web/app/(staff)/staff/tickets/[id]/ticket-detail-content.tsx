'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
  useStatusOptions,
  usePriorityOptions,
  useTypeOptions,
} from '@/lib/hooks/use-tickets';
import type { Ticket, Attachment } from '@/lib/types';
import { StatusBadge } from '@/components/premium/StatusBadge';
import { PriorityChip } from '@/components/premium/PriorityChip';
import { SlaPill } from '@/components/premium/SlaPill';
import { FileUploadZone } from '@/components/premium/FileUploadZone';
import { TicketDetailSkeleton } from '@/components/premium/SkeletonLoaders';
import { QueryError } from '@/components/QueryError';
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
import { LinkedTicketsPanel } from '@/components/tickets/LinkedTicketsPanel';
import { MergeTicketPanel } from '@/components/tickets/MergeTicketPanel';
import { SplitTicketPanel } from '@/components/tickets/SplitTicketPanel';
import { WatchersPanel } from '@/components/tickets/WatchersPanel';
import { RecipientsPanel } from '@/components/tickets/RecipientsPanel';
import { toast } from '@/components/ui/use-toast';
import { useI18n } from '@/lib/i18n';

// ── Separate RHF schemas for reply and note so they never share a single ref ──
const replySchema = z.object({
  replyBody: z.string().min(1, 'Введите текст ответа'),
});
const noteSchema = z.object({
  noteBody: z.string().min(1, 'Введите текст заметки'),
});
type ReplyForm = z.infer<typeof replySchema>;
type NoteForm = z.infer<typeof noteSchema>;

const MAX_BODY_CHARS = 10_000;

export function TicketDetailContent({ ticketId }: { ticketId: number }) {
  const { t } = useI18n();
  const ta = t.ticketActions;

  const { data: ticket, isLoading: ticketLoading, isError: ticketError, refetch } = useTicket(ticketId);
  const replyMutation = useReply(ticketId);
  const updateTicket = useUpdateTicket(ticketId);
  const { data: staffOptions = [] } = useStaffOptions();
  const { data: departmentOptions = [] } = useDepartmentOptions();
  const { data: macroOptions = [] } = useMacroOptions();
  const { data: statusOptions = [] } = useStatusOptions();
  const { data: priorityOptions = [] } = usePriorityOptions();
  const { data: typeOptions = [] } = useTypeOptions();
  const changeDepartment = useChangeTicketDepartment(ticketId);
  const applyMacro = useApplyMacro(ticketId);
  const tags = useTicketTags(ticketId);
  const [newTag, setNewTag] = useState('');

  const [replyTab, setReplyTab] = useState<'reply' | 'note'>('reply');
  // Separate attachment state per tab so they don't bleed across
  const [replyAttachmentIds, setReplyAttachmentIds] = useState<number[]>([]);
  const [noteAttachmentIds, setNoteAttachmentIds] = useState<number[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>('');
  const [departmentId, setDepartmentId] = useState<string>('');
  const [typeId, setTypeId] = useState<string>('');

  // Snapshot previous assignee/dept for error rollback
  const prevAssigneeRef = useRef<string>('');
  const prevDeptRef = useRef<string>('');

  // Sync the assignee picker once the ticket loads (it starts undefined).
  useEffect(() => {
    if (ticket?.assignee) {
      setAssigneeId(String(ticket.assignee.id));
      prevAssigneeRef.current = String(ticket.assignee.id);
    }
  }, [ticket?.assignee]);
  // Sync the department picker once the ticket loads.
  useEffect(() => {
    if (ticket?.department) {
      setDepartmentId(String(ticket.department.id));
      prevDeptRef.current = String(ticket.department.id);
    }
  }, [ticket?.department]);
  // Sync type picker
  useEffect(() => {
    if (ticket?.typeId) setTypeId(String(ticket.typeId));
  }, [ticket?.typeId]);

  const handleChangeDepartment = async (v: string) => {
    if (!v) return;
    const snapshot = prevDeptRef.current;
    setDepartmentId(v);
    prevDeptRef.current = v;
    try {
      await changeDepartment.mutateAsync(Number(v));
      const dept = departmentOptions.find((o) => o.value === v);
      toast({ title: dept ? `Отдел: ${dept.label}` : 'Отдел изменён' });
    } catch {
      // Rollback
      setDepartmentId(snapshot);
      prevDeptRef.current = snapshot;
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
      const label = statusOptions.find((s) => s.value === status)?.label ?? status;
      toast({ title: `Статус: ${label}` });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось изменить статус', variant: 'destructive' });
    }
  };
  const changePriority = async (priority: Ticket['priority']) => {
    try {
      await updateTicket.mutateAsync({ priority });
      const label = priorityOptions.find((p) => p.value === priority)?.label ?? priority;
      toast({ title: `Приоритет: ${label}` });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось изменить приоритет', variant: 'destructive' });
    }
  };
  const changeAssignee = async (v: string) => {
    const snapshot = prevAssigneeRef.current;
    setAssigneeId(v);
    prevAssigneeRef.current = v;
    try {
      await updateTicket.mutateAsync({ assigneeId: v ? Number(v) : null });
      const agent = staffOptions.find((o) => o.value === v);
      toast({ title: agent ? `Назначено: ${agent.label}` : 'Исполнитель снят' });
    } catch {
      // Rollback
      setAssigneeId(snapshot);
      prevAssigneeRef.current = snapshot;
      toast({ title: 'Ошибка', description: 'Не удалось назначить исполнителя', variant: 'destructive' });
    }
  };
  const changeType = async (v: string) => {
    setTypeId(v);
    try {
      await updateTicket.mutateAsync({ typeId: v ? Number(v) : null });
      const label = typeOptions.find((o) => o.value === v)?.label ?? v;
      toast({ title: `Тип: ${label}` });
    } catch {
      toast({ title: 'Ошибка', description: ta.typeError, variant: 'destructive' });
    }
  };

  // ── Separate RHF instances for reply and note tabs ──
  const replyForm = useForm<ReplyForm>({
    resolver: zodResolver(replySchema),
  });
  const noteForm = useForm<NoteForm>({
    resolver: zodResolver(noteSchema),
  });

  // ── Reply draft auto-save (per tab) ──
  const replyDraftKey = `th_reply_draft_${ticketId}_reply`;
  const noteDraftKey = `th_reply_draft_${ticketId}_note`;

  const replyRestoredRef = useRef(false);
  const noteRestoredRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || replyRestoredRef.current) return;
    replyForm.setValue('replyBody', localStorage.getItem(replyDraftKey) ?? '');
    replyRestoredRef.current = true;
  }, [replyDraftKey, replyForm]);

  useEffect(() => {
    if (typeof window === 'undefined' || noteRestoredRef.current) return;
    noteForm.setValue('noteBody', localStorage.getItem(noteDraftKey) ?? '');
    noteRestoredRef.current = true;
  }, [noteDraftKey, noteForm]);

  const replyBody = replyForm.watch('replyBody');
  const noteBody = noteForm.watch('noteBody');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (replyBody?.trim()) localStorage.setItem(replyDraftKey, replyBody);
    else localStorage.removeItem(replyDraftKey);
  }, [replyBody, replyDraftKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (noteBody?.trim()) localStorage.setItem(noteDraftKey, noteBody);
    else localStorage.removeItem(noteDraftKey);
  }, [noteBody, noteDraftKey]);

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

  const onSubmitReply = async (data: ReplyForm) => {
    try {
      await replyMutation.mutateAsync({
        body: data.replyBody,
        is_internal: false,
        attachmentIds: replyAttachmentIds,
      });
      replyForm.reset();
      setReplyAttachmentIds([]);
      if (typeof window !== 'undefined') localStorage.removeItem(replyDraftKey);
      toast({ title: 'Ответ отправлен' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось отправить ответ', variant: 'destructive' });
    }
  };

  const onSubmitNote = async (data: NoteForm) => {
    try {
      await replyMutation.mutateAsync({
        body: data.noteBody,
        is_internal: true,
        attachmentIds: noteAttachmentIds,
      });
      noteForm.reset();
      setNoteAttachmentIds([]);
      if (typeof window !== 'undefined') localStorage.removeItem(noteDraftKey);
      toast({ title: 'Заметка добавлена' });
    } catch {
      toast({ title: 'Ошибка', description: 'Не удалось добавить заметку', variant: 'destructive' });
    }
  };

  if (ticketLoading)
    return (
      <div className="p-6">
        <TicketDetailSkeleton />
      </div>
    );
  if (ticketError) {
    return (
      <div className="p-6">
        <QueryError message="Не удалось загрузить заявку." onRetry={() => void refetch()} />
      </div>
    );
  }
  if (!ticket) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Заявка не найдена</p>
      </div>
    );
  }

  const allReplies = ticket.replies ?? [];

  // Build status/priority options for the combobox (need value:string, label:string)
  const statusComboOptions = statusOptions.map((s) => ({ value: s.value, label: s.label }));
  const priorityComboOptions = priorityOptions.map((p) => ({ value: p.value, label: p.label }));

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

              {/* REPLY tab — separate RHF registration */}
              <TabsContent value="reply">
                <form onSubmit={replyForm.handleSubmit(onSubmitReply)}>
                  <div className="relative">
                    <Textarea
                      id="reply-textarea"
                      placeholder="Введите ответ клиенту... (R)"
                      className="min-h-[100px] resize-none"
                      maxLength={MAX_BODY_CHARS}
                      {...replyForm.register('replyBody')}
                      aria-label="Текст ответа"
                    />
                    <span className="absolute bottom-1 right-2 text-[10px] text-muted-foreground">
                      {(replyBody ?? '').length}/{MAX_BODY_CHARS} {ta.chars}
                    </span>
                  </div>
                  {replyForm.formState.errors.replyBody && (
                    <p className="mt-1 text-xs text-destructive">
                      {replyForm.formState.errors.replyBody.message}
                    </p>
                  )}
                  {replyBody && replyBody.trim() !== '' && (
                    <p className="mt-1 text-xs text-muted-foreground">Черновик сохраняется автоматически</p>
                  )}
                  <div className="mt-3 space-y-3">
                    <FileUploadZone
                      uploadEndpoint="/attachments/upload"
                      onUploaded={(ids) => setReplyAttachmentIds((prev) => [...prev, ...ids])}
                      maxFiles={10}
                      className="text-sm"
                    />
                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        disabled={replyMutation.isPending}
                        className="gap-2"
                        data-testid="reply-submit"
                      >
                        {replyMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                        Отправить
                      </Button>
                    </div>
                  </div>
                </form>
              </TabsContent>

              {/* NOTE tab — separate RHF registration */}
              <TabsContent value="note">
                <form onSubmit={noteForm.handleSubmit(onSubmitNote)}>
                  <div className="relative">
                    <Textarea
                      id="note-textarea"
                      placeholder="Внутренняя заметка (видна только агентам)..."
                      className="min-h-[100px] resize-none border-status-pending/40 bg-status-pending/5"
                      maxLength={MAX_BODY_CHARS}
                      {...noteForm.register('noteBody')}
                      aria-label="Внутренняя заметка"
                    />
                    <span className="absolute bottom-1 right-2 text-[10px] text-muted-foreground">
                      {(noteBody ?? '').length}/{MAX_BODY_CHARS} {ta.chars}
                    </span>
                  </div>
                  {noteForm.formState.errors.noteBody && (
                    <p className="mt-1 text-xs text-destructive">
                      {noteForm.formState.errors.noteBody.message}
                    </p>
                  )}
                  {noteBody && noteBody.trim() !== '' && (
                    <p className="mt-1 text-xs text-muted-foreground">Черновик сохраняется автоматически</p>
                  )}
                  <div className="mt-3 space-y-3">
                    <FileUploadZone
                      uploadEndpoint="/attachments/upload"
                      onUploaded={(ids) => setNoteAttachmentIds((prev) => [...prev, ...ids])}
                      maxFiles={10}
                      className="text-sm"
                    />
                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        disabled={replyMutation.isPending}
                        className="gap-2"
                        data-testid="note-submit"
                      >
                        {replyMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Lock className="h-4 w-4" />
                        )}
                        Добавить заметку
                      </Button>
                    </div>
                  </div>
                </form>
              </TabsContent>
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
                      options={
                        statusComboOptions.length > 0
                          ? statusComboOptions
                          : [{ value: ticket.status, label: ticket.status }]
                      }
                      value={ticket.status}
                      onValueChange={(v) => void changeStatus(v as Ticket['status'])}
                      placeholder="Статус"
                      triggerWidth="w-full"
                      disabled={updateTicket.isPending}
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">Приоритет</dt>
                  <dd className="flex-1 max-w-[150px]">
                    <Combobox
                      options={
                        priorityComboOptions.length > 0
                          ? priorityComboOptions
                          : [{ value: ticket.priority, label: ticket.priority }]
                      }
                      value={ticket.priority}
                      onValueChange={(v) => void changePriority(v as Ticket['priority'])}
                      placeholder="Приоритет"
                      triggerWidth="w-full"
                      disabled={updateTicket.isPending}
                    />
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt className="text-muted-foreground">{ta.type}</dt>
                  <dd className="flex-1 max-w-[150px]">
                    <Combobox
                      options={typeOptions}
                      value={typeId}
                      onValueChange={(v) => void changeType(v)}
                      placeholder={ta.typePlaceholder}
                      searchPlaceholder="Поиск типа..."
                      emptyMessage="Типы не найдены"
                      triggerWidth="w-full"
                      disabled={updateTicket.isPending}
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
                disabled={updateTicket.isPending}
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
                      onClick={() =>
                        tags.remove.mutate(tag, {
                          onError: () =>
                            toast({
                              title: 'Ошибка',
                              description: 'Не удалось удалить метку',
                              variant: 'destructive',
                            }),
                        })
                      }
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
                  if (!name) return;
                  tags.add.mutate(name, {
                    onSuccess: () => setNewTag(''),
                    onError: () =>
                      toast({
                        title: 'Ошибка',
                        description: 'Не удалось добавить метку',
                        variant: 'destructive',
                      }),
                  });
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

            {/* Linked tickets (client ↔ supplier) */}
            <Separator />
            <section>
              <LinkedTicketsPanel ticketId={ticketId} />
            </section>

            {/* Merge */}
            <Separator />
            <section>
              <MergeTicketPanel ticketId={ticketId} />
            </section>

            {/* Split */}
            <Separator />
            <section>
              <SplitTicketPanel
                ticketId={ticketId}
                posts={allReplies.map((r) => ({
                  id: r.id,
                  label: `${r.author?.name ?? ''}: ${(r.body ?? '').slice(0, 80)}`.trim(),
                }))}
              />
            </section>

            {/* Watchers */}
            <Separator />
            <section>
              <WatchersPanel ticketId={ticketId} />
            </section>

            {/* Recipients CC/BCC */}
            <Separator />
            <section>
              <RecipientsPanel ticketId={ticketId} />
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
