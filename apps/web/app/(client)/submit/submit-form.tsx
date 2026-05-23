'use client';

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { motion } from 'framer-motion';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileUploadZone } from '@/components/premium/FileUploadZone';
import { useSubmitPublicTicket } from '@/lib/hooks/use-tickets';
import { generateTicketMask } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { api } from '@/lib/api';

interface Department {
  id: number;
  title: string;
}

const PRIORITY_MAP: Record<string, number | undefined> = {
  urgent: 1,
  high: 2,
  normal: 3,
  low: 4,
};

const submitSchema = z.object({
  name: z.string().min(2, 'Введите имя'),
  email: z.string().email('Введите корректный email'),
  subject: z.string().min(5, 'Минимум 5 символов'),
  body: z.string().min(20, 'Опишите проблему подробнее (мин. 20 символов)'),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).default('normal'),
  department_id: z.string().optional(),
});
type SubmitForm = z.infer<typeof submitSchema>;

export function SubmitTicketForm() {
  const createTicket = useSubmitPublicTicket();
  const [successMask, setSuccessMask] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  // Attachments are collected for UX; the public submit endpoint does not yet accept uploads.
  const [, setFiles] = useState<File[]>([]);

  // Fetch departments on mount; gracefully degrade if the endpoint is auth-gated.
  useEffect(() => {
    api
      .get<Department[] | { data: Department[] }>('/departments')
      .then((res) => {
        const list = Array.isArray(res) ? res : ((res as { data: Department[] }).data ?? []);
        setDepartments(list);
      })
      .catch(() => {
        // Endpoint requires auth — leave list empty so the select is hidden
        setDepartments([]);
      });
  }, []);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
    reset,
  } = useForm<SubmitForm>({
    resolver: zodResolver(submitSchema),
    defaultValues: { priority: 'normal' },
  });

  const onSubmit = async (data: SubmitForm) => {
    try {
      const ticket = await createTicket.mutateAsync({
        subject: data.subject,
        contents: data.body,
        requesterName: data.name,
        requesterEmail: data.email,
        departmentId: data.department_id ? parseInt(data.department_id) : undefined,
        // CL-6: wire priority slug → numeric priorityId (cast needed because PublicTicketInput
        // does not declare priorityId; value is still forwarded to the API at runtime)
        ...({ priorityId: PRIORITY_MAP[data.priority] } as object),
      } as Parameters<typeof createTicket.mutateAsync>[0]);
      // CL-3: persist the email so "Мои заявки" can filter by it
      if (typeof window !== 'undefined') {
        localStorage.setItem('client_email', data.email);
      }
      setSuccessMask(ticket?.mask ?? generateTicketMask(Date.now() % 99999));
      reset();
    } catch (err: unknown) {
      // CL-1: surface the error instead of swallowing it
      const message =
        err instanceof Error ? err.message : 'Не удалось отправить обращение. Попробуйте ещё раз.';
      toast({ title: 'Ошибка отправки', description: message, variant: 'destructive' });
    }
  };

  if (successMask) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="rounded-xl border border-status-resolved/30 bg-status-resolved/5 p-8 text-center"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring' }}
          className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-status-resolved/10"
        >
          <CheckCircle2 className="h-8 w-8 text-status-resolved" />
        </motion.div>
        <h2 className="text-lg font-bold">Обращение зарегистрировано</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Спасибо — мы зарегистрировали обращение{' '}
          <code className="font-mono font-bold text-foreground">{successMask}</code>, специалист скоро
          ответит.
        </p>
        <Button className="mt-6" variant="outline" onClick={() => setSuccessMask(null)}>
          Создать ещё одно
        </Button>
      </motion.div>
    );
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="name">Ваше имя</Label>
          <Input id="name" placeholder="Иван Иванов" {...register('name')} aria-invalid={!!errors.name} />
          {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            placeholder="ivan@example.com"
            {...register('email')}
            aria-invalid={!!errors.email}
          />
          {errors.email && <p className="text-xs text-destructive">{errors.email.message}</p>}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="subject">Тема обращения</Label>
        <Input
          id="subject"
          placeholder="Кратко опишите проблему"
          {...register('subject')}
          aria-invalid={!!errors.subject}
        />
        {errors.subject && <p className="text-xs text-destructive">{errors.subject.message}</p>}
      </div>

      <div className={`grid gap-4 ${departments.length > 0 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <div className="space-y-1.5">
          <Label>Приоритет</Label>
          <Select
            defaultValue="normal"
            onValueChange={(v) => setValue('priority', v as SubmitForm['priority'])}
          >
            <SelectTrigger aria-label="Выберите приоритет">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="urgent">Критический</SelectItem>
              <SelectItem value="high">Высокий</SelectItem>
              <SelectItem value="normal">Обычный</SelectItem>
              <SelectItem value="low">Низкий</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {/* CL-2: only render department select when we have real data from the API */}
        {departments.length > 0 && (
          <div className="space-y-1.5">
            <Label>Отдел</Label>
            <Select onValueChange={(v) => setValue('department_id', v)}>
              <SelectTrigger aria-label="Выберите отдел">
                <SelectValue placeholder="Автоматически" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="body">Описание</Label>
        <Textarea
          id="body"
          placeholder="Подробно опишите проблему: что произошло, когда началось, что уже пробовали..."
          className="min-h-[140px]"
          {...register('body')}
          aria-invalid={!!errors.body}
        />
        {errors.body && <p className="text-xs text-destructive">{errors.body.message}</p>}
      </div>

      <div className="space-y-1.5">
        <Label>Вложения (необязательно)</Label>
        <FileUploadZone
          onFiles={setFiles}
          accept="image/*,.pdf,.txt,.log,.pcap"
          maxSizeMb={25}
          maxFiles={5}
        />
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={createTicket.isPending}
        data-testid="submit-ticket-btn"
      >
        {createTicket.isPending ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Отправка...
          </>
        ) : (
          'Отправить обращение'
        )}
      </Button>
    </form>
  );
}
