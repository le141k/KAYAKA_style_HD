'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, Lock, Send, Loader2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { useTicket, useReplies, useReply } from '@/lib/hooks/use-tickets';
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
import { cn, formatDate, formatRelative, getInitials } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { MOCK_USERS } from '@/lib/mock-data';

// Build assignee options from mock staff users
const ASSIGNEE_OPTIONS = MOCK_USERS.filter((u) => u.role === 'agent' || u.role === 'admin').map((u) => ({
  value: String(u.id),
  label: u.name,
  description: u.email,
}));

const replySchema = z.object({
  body: z.string().min(1, 'Введите текст ответа'),
});
type ReplyForm = z.infer<typeof replySchema>;

export function TicketDetailContent({ ticketId }: { ticketId: number }) {
  const { data: ticket, isLoading: ticketLoading } = useTicket(ticketId);
  const { data: replies, isLoading: repliesLoading } = useReplies(ticketId);
  const replyMutation = useReply(ticketId);

  const [replyTab, setReplyTab] = useState<'reply' | 'note'>('reply');
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [assigneeId, setAssigneeId] = useState<string>(ticket?.assignee ? String(ticket.assignee.id) : '');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ReplyForm>({
    resolver: zodResolver(replySchema),
  });

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
    });
    reset();
    setAttachedFiles([]);
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

  const allReplies = replies ?? ticket.replies ?? [];

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
            {repliesLoading ? (
              <div className="text-sm text-muted-foreground">Загрузка ответов...</div>
            ) : (
              allReplies.map((reply, i) => (
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
                      <p className="text-xs text-muted-foreground">{formatRelative(reply.created_at)}</p>
                    </div>
                  </div>
                  <p className="text-sm leading-relaxed whitespace-pre-line">{reply.body}</p>
                </motion.div>
              ))
            )}
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
                    id="reply-textarea"
                    placeholder="Внутренняя заметка (видна только агентам)..."
                    className="min-h-[100px] resize-none border-status-pending/40 bg-status-pending/5"
                    {...register('body')}
                    aria-label="Внутренняя заметка"
                  />
                </TabsContent>
                {errors.body && <p className="mt-1 text-xs text-destructive">{errors.body.message}</p>}

                <div className="mt-3 space-y-3">
                  <FileUploadZone onFiles={setAttachedFiles} maxFiles={5} className="text-sm" />
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
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Статус</dt>
                  <dd>
                    <StatusBadge status={ticket.status} size="sm" />
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-muted-foreground">Приоритет</dt>
                  <dd>
                    <PriorityChip priority={ticket.priority} />
                  </dd>
                </div>
                {ticket.department && (
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Отдел</dt>
                    <dd className="font-medium">{ticket.department.name}</dd>
                  </div>
                )}
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
                options={ASSIGNEE_OPTIONS}
                value={assigneeId}
                onValueChange={(v) => {
                  setAssigneeId(v);
                  const agent = MOCK_USERS.find((u) => String(u.id) === v);
                  toast({
                    title: agent ? `Назначено: ${agent.name}` : 'Исполнитель снят',
                  });
                }}
                placeholder="Назначить исполнителя"
                searchPlaceholder="Поиск агента..."
                emptyMessage="Агент не найден"
                triggerWidth="w-full"
              />
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
            {ticket.tags && ticket.tags.length > 0 && (
              <>
                <Separator />
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Метки
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {ticket.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
