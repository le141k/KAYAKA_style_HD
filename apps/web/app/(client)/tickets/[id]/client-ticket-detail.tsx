"use client";

import Link from "next/link";
import { ArrowLeft, Send, Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { motion } from "framer-motion";
import { useTicket, useReplies, useReply } from "@/lib/hooks/use-tickets";
import { StatusBadge } from "@/components/premium/StatusBadge";
import { SlaPill } from "@/components/premium/SlaPill";
import { TicketDetailSkeleton } from "@/components/premium/SkeletonLoaders";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatRelative, getInitials } from "@/lib/utils";
import { toast } from "@/components/ui/use-toast";

const replySchema = z.object({
  body: z.string().min(1, "Введите текст"),
});

export function ClientTicketDetail({ ticketId }: { ticketId: number }) {
  const { data: ticket, isLoading } = useTicket(ticketId);
  const { data: replies } = useReplies(ticketId);
  const replyMutation = useReply(ticketId);

  type ReplyForm = { body: string };
  const { register, handleSubmit, reset, formState: { errors } } = useForm<ReplyForm>({
    resolver: zodResolver(replySchema),
  });

  if (isLoading) return <TicketDetailSkeleton />;
  if (!ticket) return <p className="text-muted-foreground">Обращение не найдено</p>;

  const allReplies = replies ?? ticket.replies ?? [];
  const publicReplies = allReplies.filter((r) => !r.is_internal);

  const onSubmit = async (data: ReplyForm) => {
    await replyMutation.mutateAsync({ body: data.body });
    reset();
    toast({ title: "Сообщение отправлено" });
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
                {reply.author.role !== "client" && (
                  <span className="ml-1.5 text-xs text-primary">· Специалист</span>
                )}
              </div>
              <span className="ml-auto text-xs text-muted-foreground">{formatRelative(reply.created_at)}</span>
            </div>
            <p className="text-sm leading-relaxed whitespace-pre-line">{reply.body}</p>
          </motion.div>
        ))}
      </div>

      {/* Reply form (only if not resolved/closed) */}
      {ticket.status !== "resolved" && ticket.status !== "closed" && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h3 className="mb-3 text-sm font-semibold">Добавить сообщение</h3>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
            <Textarea
              placeholder="Введите дополнительную информацию или вопрос..."
              className="min-h-[100px]"
              {...register("body")}
              data-testid="client-reply-input"
            />
            {errors.body && (
              <p className="text-xs text-destructive">{String(errors.body.message)}</p>
            )}
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
