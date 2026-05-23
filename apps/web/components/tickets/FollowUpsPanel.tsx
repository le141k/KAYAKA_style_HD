'use client';

import { useState } from 'react';
import {
  useFollowUps,
  useCreateFollowUp,
  useToggleFollowUp,
  useDeleteFollowUp,
  type FollowUp,
} from '@/lib/hooks/use-follow-ups';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

function isOverdue(f: FollowUp): boolean {
  return !f.completed && new Date(f.dueAt).getTime() < Date.now();
}

function staffName(f: FollowUp): string {
  if (!f.staff) return '';
  return `${f.staff.firstName} ${f.staff.lastName}`.trim();
}

export function FollowUpsPanel({ ticketId }: { ticketId: number }) {
  const { data: followUps, isLoading } = useFollowUps(ticketId);
  const createFollowUp = useCreateFollowUp(ticketId);
  const toggleFollowUp = useToggleFollowUp(ticketId);
  const deleteFollowUp = useDeleteFollowUp(ticketId);

  const [dueAt, setDueAt] = useState('');
  const [note, setNote] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dueAt) return;
    createFollowUp.mutate(
      { dueAt: new Date(dueAt).toISOString(), note: note.trim() || undefined },
      {
        onSuccess: () => {
          setDueAt('');
          setNote('');
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold">Follow-ups</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit} className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="follow-up-due" className="text-xs">
              Due date
            </Label>
            <Input
              id="follow-up-due"
              type="datetime-local"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="follow-up-note" className="text-xs">
              Note (optional)
            </Label>
            <Textarea
              id="follow-up-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What needs following up?"
              rows={2}
            />
          </div>
          <Button type="submit" size="sm" disabled={!dueAt || createFollowUp.isPending}>
            {createFollowUp.isPending ? 'Scheduling…' : 'Schedule follow-up'}
          </Button>
        </form>

        <div className="space-y-2">
          {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!isLoading && (followUps?.length ?? 0) === 0 && (
            <p className="text-xs text-muted-foreground">No follow-ups scheduled.</p>
          )}
          {followUps?.map((f) => {
            const overdue = isOverdue(f);
            return (
              <div
                key={f.id}
                className={cn(
                  'flex items-start gap-2 rounded-md border p-2 text-sm',
                  overdue && 'border-destructive/50 bg-destructive/10',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={f.completed}
                  disabled={toggleFollowUp.isPending}
                  onChange={(e) => toggleFollowUp.mutate({ id: f.id, completed: e.target.checked })}
                  aria-label="Mark follow-up complete"
                />
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      'font-medium',
                      f.completed && 'text-muted-foreground line-through',
                      overdue && 'text-destructive',
                    )}
                  >
                    {new Date(f.dueAt).toLocaleString()}
                    {overdue && <span className="ml-2 text-xs font-semibold">Overdue</span>}
                  </div>
                  {f.note && (
                    <div className={cn('text-xs text-muted-foreground', f.completed && 'line-through')}>
                      {f.note}
                    </div>
                  )}
                  {staffName(f) && <div className="text-xs text-muted-foreground">by {staffName(f)}</div>}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  disabled={deleteFollowUp.isPending}
                  onClick={() => deleteFollowUp.mutate(f.id)}
                  aria-label="Delete follow-up"
                >
                  Delete
                </Button>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
