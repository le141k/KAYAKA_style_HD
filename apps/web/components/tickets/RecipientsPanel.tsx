'use client';

import { useState } from 'react';
import { Mail, X, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { useTicketRecipients } from '@/lib/hooks/use-tickets';
import { useI18n } from '@/lib/i18n';

/**
 * Sidebar panel for managing CC/BCC recipients.
 * GET /tickets/:id/recipients
 * POST /tickets/:id/recipients { email, name?, type: 'cc'|'bcc' }
 * DELETE /tickets/:id/recipients/:id
 */
export function RecipientsPanel({ ticketId }: { ticketId: number }) {
  const { t } = useI18n();
  const ta = t.ticketActions;
  const { list, add, remove } = useTicketRecipients(ticketId);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<'cc' | 'bcc'>('cc');

  function handleAdd() {
    if (!email.trim()) return;
    add.mutate(
      { email: email.trim(), name: name.trim() || undefined, type },
      {
        onSuccess: () => {
          setEmail('');
          setName('');
        },
        onError: () => toast({ title: 'Ошибка', description: ta.recipientsAddError, variant: 'destructive' }),
      },
    );
  }

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Mail className="h-3.5 w-3.5" />
        {ta.recipients}
      </h3>

      {list.isLoading ? (
        <p className="text-xs text-muted-foreground">Загрузка…</p>
      ) : (list.data?.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">{ta.recipientsEmpty}</p>
      ) : (
        <ul className="space-y-1">
          {list.data!.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                {r.type}
              </span>
              <span className="min-w-0 flex-1 truncate" title={r.email}>
                {r.name ? `${r.name} <${r.email}>` : r.email}
              </span>
              <button
                type="button"
                aria-label={`Удалить получателя ${r.email}`}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  remove.mutate(r.id, {
                    onError: () =>
                      toast({
                        title: 'Ошибка',
                        description: ta.recipientsRemoveError,
                        variant: 'destructive',
                      }),
                  })
                }
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5">
          <select
            value={type}
            onChange={(e) => setType(e.target.value as 'cc' | 'bcc')}
            className="h-7 rounded-md border border-input bg-transparent px-1.5 text-xs"
          >
            <option value="cc">CC</option>
            <option value="bcc">BCC</option>
          </select>
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAdd();
              }
            }}
            placeholder={ta.recipientsEmailPlaceholder}
            type="email"
            className="h-7 flex-1 text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ta.recipientsNamePlaceholder}
            className="h-7 flex-1 text-xs"
          />
          <Button size="sm" variant="outline" onClick={handleAdd} disabled={!email.trim() || add.isPending}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            {ta.recipientsAdd}
          </Button>
        </div>
      </div>
    </section>
  );
}
