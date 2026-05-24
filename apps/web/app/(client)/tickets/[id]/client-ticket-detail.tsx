'use client';

import { useState, useRef } from 'react';
import Link from 'next/link';
import { ArrowLeft, Send, Loader2, Paperclip, Download } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { useClientTicket, useClientReply } from '@/lib/hooks/use-client-tickets';
import { StatusBadge } from '@/components/premium/StatusBadge';
import { SlaPill } from '@/components/premium/SlaPill';
import { TicketDetailSkeleton } from '@/components/premium/SkeletonLoaders';
import { FileUploadZone, type FileUploadZoneHandle } from '@/components/premium/FileUploadZone';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { formatDate, getInitials } from '@/lib/utils';
import { RelativeTime } from '@/components/RelativeTime';
import { toast } from '@/components/ui/use-toast';
import type { Attachment } from '@/lib/types';

const replySchema = z.object({
  contents: z.string().min(1, 'Введите текст'),
});

type ReplyForm = { contents: string };

/** A v4 UUID claim token for reply attachment orphan-binding. */
function genClaimToken(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((att) => (
        <a
          key={att.id}
          href={att.url}
          download={att.filename}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs text-foreground hover:bg-primary/10 hover:border-primary/40 transition-colors"
        >
          <Paperclip className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          <span className="max-w-[180px] truncate">{att.filename}</span>
          <Download className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        </a>
      ))}
    </div>
  );
}

export function ClientTicketDetail({ ticketId }: { ticketId: number }) {
  const { data: ticket, isLoading } = useClientTicket(ticketId);
  const replyMutation = useClientReply(ticketId);

  const [attachmentIds, setAttachmentIds] = useState<number[]>([]);
  const [claimToken] = useState(genClaimToken);
  const fileUploadRef = useRef<FileUploadZoneHandle>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ReplyForm>({
    resolver: zodResolver(replySchema),
  });

  if (isLoading) return <TicketDetailSkeleton />;
  if (!ticket) return <p className="text-muted-foreground">Обращение не найдено</p>;

  const allReplies = ticket.replies ?? [];
  const publicReplies = allReplies.filter((r) => !r.is_internal);

  const onSubmit = async (data: ReplyForm) => {
    try {
      await replyMutation.mutateAsync({
        contents: data.contents,
        ...(attachmentIds.length ? { attachmentIds, attachmentClaimToken: claimToken } : {}),
      });
      reset();
      setAttachmentIds([]);
      fileUploadRef.current?.clear();
      toast({
        title: 'Сообщение отправлено',
        description: ticket.status === 'resolved' ? 'Обращение снова открыто для рассмотрения.' : undefined,
      });
    } catch {
      toast({
        title: 'Ошибка',
        description: 'Не удалось отправить сообщение. Попробуйте ещё раз.',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="space-y-6">
      {/* Back */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/tickets">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Назад
          </Link>
        </Button>
        <code className="font-mono text-sm text-muted-foreground">{ticket.mask}</code>
        <StatusBadge status={ticket.status} />
        <SlaPill dueAt={ticket.sla_due_at} />
      </div>

      <h1 className="text-xl font-bold">{ticket.subject}</h1>

      {/* Thread */}
      <div className="space-y-4">
        {/* Original */}
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <Avatar className="h-7 w-7">
              <AvatarFallback className="text-xs">{getInitials(ticket.requester.name)}</AvatarFallback>
            </Avatar>
            <span className="text-sm font-semibold">{ticket.requester.name}</span>
            <span className="text-xs text-muted-foreground">{formatDate(ticket.created_at)}</span>
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-line">{ticket.body}</p>
        </div>

        {/* Public replies */}
        {publicReplies.map((reply, i) => (
          <motion.div
            key={reply.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
            className="rounded-xl border border-border bg-card p-5"
          >
            <div className="mb-2 flex items-center gap-2">
              <Avatar className="h-7 w-7">
                <AvatarFallback className="text-xs">{getInitials(reply.author.name)}</AvatarFallback>
              </Avatar>
              <div>
                <span className="text-sm font-semibold">{reply.author.name}</span>
                {reply.author.role !== 'client' && (
                  <span className="ml-1.5 text-xs text-primary">· Специалист</span>
                )}
              </div>
              <RelativeTime className="ml-auto text-xs text-muted-foreground" date={reply.created_at} />
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-line">{reply.body}</p>
            {reply.attachments && reply.attachments.length > 0 && (
              <AttachmentList attachments={reply.attachments} />
            )}
          </motion.div>
        ))}
      </div>

      {/* Reply form — hidden only when fully closed. A reply to a *resolved*
          ticket reopens it (server publicReply reopen path), so keep it allowed. */}
      {ticket.status !== 'closed' && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="mb-3 text-sm font-semibold">
            {ticket.status === 'resolved'
              ? 'Ответить (обращение будет открыто заново)'
              : 'Добавить сообщение'}
          </h3>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            <Textarea
              placeholder="Введите дополнительную информацию или вопрос..."
              className="min-h-[100px]"
              {...register('contents')}
              data-testid="client-reply-input"
            />
            {errors.contents && <p className="text-xs text-destructive">{String(errors.contents.message)}</p>}

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Вложения (необязательно)</Label>
              <FileUploadZone
                ref={fileUploadRef}
                uploadEndpoint="/attachments/upload/public"
                claimToken={claimToken}
                onUploaded={(ids) => setAttachmentIds((prev) => [...prev, ...ids])}
                accept="image/*,.pdf,.txt,.log,.pcap"
                maxSizeMb={25}
                maxFiles={5}
              />
            </div>

            <div className="flex justify-end">
              <Button type="submit" disabled={replyMutation.isPending} data-testid="client-reply-btn">
                {replyMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                Отправить
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
