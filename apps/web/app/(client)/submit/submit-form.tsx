'use client';

import { useState, useEffect, useRef } from 'react';
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
import { FileUploadZone, type FileUploadZoneHandle } from '@/components/premium/FileUploadZone';
import { useSubmitPublicTicket } from '@/lib/hooks/use-tickets';
import { useCustomFields } from '@/lib/hooks/use-custom-fields';
import {
  CustomFieldsSection,
  buildCustomFieldsPayload,
  type CustomFieldValue,
} from '@/components/custom-fields/CustomFieldsSection';
import { generateTicketMask } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { api } from '@/lib/api';
import { TurnstileWidget, type TurnstileWidgetHandle } from '@/components/security/TurnstileWidget';

interface Department {
  id: number;
  title: string;
}

/**
 * Resolve a priority slug → its DB id dynamically via the public endpoint, so we
 * never assume seed-order ids. (The old static map was inverted: it sent
 * urgent→1, but on a clean DB id 1 is Low — so "Критический" became "Низкий".)
 */
async function resolvePriorityId(slug: string): Promise<number | undefined> {
  try {
    const priorities = await api.get<{ id: number; title: string }[]>('/ticket-priorities/public');
    return priorities.find((p) => p.title.toLowerCase() === slug)?.id;
  } catch {
    return undefined;
  }
}

const submitSchema = z.object({
  name: z.string().min(2, 'Введите имя'),
  email: z.string().email('Введите корректный email'),
  subject: z.string().min(5, 'Минимум 5 символов'),
  body: z.string().min(20, 'Опишите проблему подробнее (мин. 20 символов)'),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).default('normal'),
  department_id: z.string().optional(),
});
type SubmitForm = z.infer<typeof submitSchema>;

/**
 * A v4 UUID claim token, always non-empty. Uses crypto.randomUUID when available
 * and an RFC4122 fallback otherwise — never returns '' (H8-4), so the server-side
 * token enforcement can't be bypassed and a legit attachment isn't silently dropped.
 */
function genClaimToken(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function SubmitTicketForm() {
  const createTicket = useSubmitPublicTicket();
  const [successMask, setSuccessMask] = useState<string | null>(null);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [attachmentIds, setAttachmentIds] = useState<number[]>([]);
  const fileUploadRef = useRef<FileUploadZoneHandle>(null);
  const ticketChallengeRef = useRef<TurnstileWidgetHandle>(null);
  const uploadChallengeRef = useRef<TurnstileWidgetHandle>(null);
  const [ticketChallenge, setTicketChallenge] = useState<string>();
  const [uploadChallenge, setUploadChallenge] = useState<string>();
  // One orphan-claim secret per form session: the server scopes orphan adoption to
  // it so uploaded files can only be attached to THIS submit (not stolen by others).
  const [claimToken] = useState(genClaimToken);

  // TICKET-scope custom fields (public, read-only) + their collected values.
  const { fields: customFields } = useCustomFields('TICKET');
  const [cfValues, setCfValues] = useState<Record<string, CustomFieldValue>>({});
  const [cfErrors, setCfErrors] = useState<Record<string, string>>({});

  // Fetch the PUBLIC departments list on mount (unauthenticated-friendly).
  useEffect(() => {
    api
      .get<Department[] | { data: Department[] }>('/departments/public')
      .then((res) => {
        const list = Array.isArray(res) ? res : ((res as { data: Department[] }).data ?? []);
        setDepartments(list);
      })
      .catch(() => {
        // Endpoint unavailable — leave list empty so the select is hidden
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
    // Validate + collect custom fields before hitting the API (required CFs would
    // otherwise be rejected server-side with no field-level feedback).
    const { values: cfPayload, missing } = buildCustomFieldsPayload(customFields, cfValues);
    if (missing.length) {
      setCfErrors(Object.fromEntries(missing.map((f) => [f.fieldKey, 'Обязательное поле'])));
      return;
    }
    setCfErrors({});
    try {
      if (!ticketChallenge) throw new Error('Пройдите проверку безопасности.');
      // CL-6: map priority slug → numeric priorityId dynamically (no seed-order assumptions).
      const priorityId = await resolvePriorityId(data.priority);
      const ticket = await createTicket.mutateAsync({
        subject: data.subject,
        contents: data.body,
        requesterName: data.name,
        requesterEmail: data.email,
        challengeToken: ticketChallenge,
        departmentId: data.department_id ? parseInt(data.department_id) : undefined,
        // cast needed because PublicTicketInput does not declare priorityId; the
        // value is still forwarded to the API at runtime.
        ...({ priorityId } as object),
        ...(Object.keys(cfPayload).length ? { customFields: cfPayload } : {}),
        ...(attachmentIds.length ? { attachmentIds, attachmentClaimToken: claimToken } : {}),
      } as Parameters<typeof createTicket.mutateAsync>[0]);
      // S2-9: no longer persist the email — "Мои заявки" is gated by the verified th_client
      // session, not a self-typed/localStorage email (that lookup was an IDOR and is removed).
      setSuccessMask(ticket?.mask ?? generateTicketMask(Date.now() % 99999));
      reset();
      setCfValues({});
      setAttachmentIds([]);
      fileUploadRef.current?.clear();
    } catch (err: unknown) {
      // CL-1: surface the error instead of swallowing it
      const message =
        err instanceof Error ? err.message : 'Не удалось отправить обращение. Попробуйте ещё раз.';
      toast({ title: 'Ошибка отправки', description: message, variant: 'destructive' });
    } finally {
      ticketChallengeRef.current?.reset();
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

      {customFields.length > 0 && (
        <CustomFieldsSection
          fields={customFields}
          values={cfValues}
          onChange={(key, value) => setCfValues((prev) => ({ ...prev, [key]: value }))}
          errors={cfErrors}
        />
      )}

      <div className="space-y-1.5">
        <Label>Вложения (необязательно)</Label>
        <TurnstileWidget ref={uploadChallengeRef} action="public-upload" onToken={setUploadChallenge} />
        <FileUploadZone
          ref={fileUploadRef}
          uploadEndpoint="/attachments/upload/public"
          claimToken={claimToken}
          challengeToken={uploadChallenge}
          onChallengeConsumed={() => uploadChallengeRef.current?.reset()}
          onUploaded={(ids) => setAttachmentIds((prev) => [...prev, ...ids])}
          onRemoved={(id) => setAttachmentIds((prev) => prev.filter((value) => value !== id))}
          accept="image/*,.pdf,.txt,.log,.pcap"
          maxSizeMb={25}
          maxFiles={5}
        />
      </div>

      <TurnstileWidget ref={ticketChallengeRef} action="ticket-create" onToken={setTicketChallenge} />

      <Button
        type="submit"
        className="w-full"
        disabled={createTicket.isPending || !ticketChallenge}
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
