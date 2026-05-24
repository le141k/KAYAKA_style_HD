'use client';

import { useState } from 'react';
import { GitMerge, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { useMergeTicket } from '@/lib/hooks/use-tickets';
import { useI18n } from '@/lib/i18n';

/**
 * Sidebar panel for merging the current ticket into a target ticket.
 * POST /tickets/:id/merge { targetTicketId }
 */
export function MergeTicketPanel({ ticketId }: { ticketId: number }) {
  const { t } = useI18n();
  const ta = t.ticketActions;
  const merge = useMergeTicket(ticketId);
  const [open, setOpen] = useState(false);
  const [targetId, setTargetId] = useState('');

  function handleMerge() {
    const id = Number(targetId.trim());
    if (!Number.isInteger(id) || id <= 0) return;
    merge.mutate(id, {
      onSuccess: () => {
        toast({ title: ta.mergeSuccess });
        setTargetId('');
        setOpen(false);
      },
      onError: () => toast({ title: 'Ошибка', description: ta.mergeError, variant: 'destructive' }),
    });
  }

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <GitMerge className="h-3.5 w-3.5" />
        {ta.mergeTitle}
      </h3>

      {!open ? (
        <Button size="sm" variant="secondary" className="w-full" onClick={() => setOpen(true)}>
          {ta.merge}
        </Button>
      ) : (
        <div className="space-y-1.5 rounded-md border border-border p-2">
          <Input
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleMerge();
              }
            }}
            placeholder={ta.mergeTargetPlaceholder}
            inputMode="numeric"
            className="h-8"
          />
          <div className="flex gap-1.5">
            <Button size="sm" onClick={handleMerge} disabled={!targetId.trim() || merge.isPending}>
              {ta.mergeSubmit}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
