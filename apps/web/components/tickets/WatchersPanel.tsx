'use client';

import { useState } from 'react';
import { Eye, X, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { useTicketWatchers } from '@/lib/hooks/use-tickets';
import { useI18n } from '@/lib/i18n';

/**
 * Sidebar panel for managing ticket watchers.
 * GET /tickets/:id/watchers
 * POST /tickets/:id/watchers { staffId }
 * DELETE /tickets/:id/watchers/:staffId
 */
export function WatchersPanel({ ticketId }: { ticketId: number }) {
  const { t } = useI18n();
  const ta = t.ticketActions;
  const { list, add, remove } = useTicketWatchers(ticketId);
  const [staffIdInput, setStaffIdInput] = useState('');

  function handleAdd() {
    const id = Number(staffIdInput.trim());
    if (!Number.isInteger(id) || id <= 0) return;
    add.mutate(id, {
      onSuccess: () => setStaffIdInput(''),
      onError: () => toast({ title: 'Ошибка', description: ta.watchersAddError, variant: 'destructive' }),
    });
  }

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Eye className="h-3.5 w-3.5" />
        {ta.watchers}
      </h3>

      {list.isLoading ? (
        <p className="text-xs text-muted-foreground">Загрузка…</p>
      ) : (list.data?.length ?? 0) === 0 ? (
        <p className="text-xs text-muted-foreground">{ta.watchersEmpty}</p>
      ) : (
        <ul className="space-y-1">
          {list.data!.map((w) => (
            <li key={w.staffId} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate" title={w.email}>
                {w.name || w.email}
              </span>
              <button
                type="button"
                aria-label={`Удалить наблюдателя ${w.name}`}
                className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                onClick={() =>
                  remove.mutate(w.staffId, {
                    onError: () =>
                      toast({ title: 'Ошибка', description: ta.watchersRemoveError, variant: 'destructive' }),
                  })
                }
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-1.5">
        <Input
          value={staffIdInput}
          onChange={(e) => setStaffIdInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleAdd();
            }
          }}
          placeholder={ta.watchersAddPlaceholder}
          inputMode="numeric"
          className="h-7 flex-1 text-xs"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={handleAdd}
          disabled={!staffIdInput.trim() || add.isPending}
        >
          <Plus className="h-3.5 w-3.5" />
          {ta.watchersAdd}
        </Button>
      </div>
    </section>
  );
}
