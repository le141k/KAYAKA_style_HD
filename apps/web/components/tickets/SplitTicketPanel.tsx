'use client';

import { useState } from 'react';
import { GitBranch, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/use-toast';
import { useSplitTicket } from '@/lib/hooks/use-tickets';
import { useI18n } from '@/lib/i18n';

export interface SplitablePost {
  id: number;
  label: string;
}

/**
 * Sidebar panel for splitting selected posts off the current ticket into a new
 * ticket. POST /tickets/:id/split { postIds, subject }.
 */
export function SplitTicketPanel({ ticketId, posts }: { ticketId: number; posts: SplitablePost[] }) {
  const { t } = useI18n();
  const ta = t.ticketActions;
  const split = useSplitTicket(ticketId);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [subject, setSubject] = useState('');

  function toggle(id: number) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function handleSplit() {
    if (selected.length === 0 || !subject.trim()) return;
    split.mutate(
      { postIds: selected, subject: subject.trim() },
      {
        onSuccess: (res) => {
          toast({ title: ta.splitSuccess, description: res?.ticket?.mask });
          setSelected([]);
          setSubject('');
          setOpen(false);
        },
        onError: () => toast({ title: 'Ошибка', description: ta.splitError, variant: 'destructive' }),
      },
    );
  }

  return (
    <section className="space-y-2">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5" />
        {ta.splitTitle}
      </h3>

      {!open ? (
        <Button size="sm" variant="secondary" className="w-full" onClick={() => setOpen(true)}>
          {ta.split}
        </Button>
      ) : (
        <div className="space-y-2 rounded-md border border-border p-2">
          {posts.length === 0 ? (
            <p className="text-xs text-muted-foreground">{ta.splitNoSelectable}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{ta.splitSelectHint}</p>
              <div className="max-h-40 space-y-1 overflow-y-auto">
                {posts.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={selected.includes(p.id)}
                      onChange={() => toggle(p.id)}
                    />
                    <span className="line-clamp-2">{p.label}</span>
                  </label>
                ))}
              </div>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={ta.splitSubjectPlaceholder}
                className="h-8"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  className="flex-1"
                  disabled={split.isPending || selected.length === 0 || !subject.trim()}
                  onClick={handleSplit}
                >
                  {ta.splitSubmit}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setSelected([]);
                  }}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
