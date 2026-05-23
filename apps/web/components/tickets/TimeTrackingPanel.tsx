'use client';

import { useState } from 'react';
import { Clock, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  useTimeEntries,
  useLogTime,
  useDeleteTimeEntry,
  type TimeEntry,
} from '@/lib/hooks/use-time-tracking';

/** Render minutes as a compact "Hh Mm" / "Mm" string. */
function formatMinutes(total: number): string {
  if (total <= 0) return '0m';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : ''].filter(Boolean).join(' ') || '0m';
}

function staffName(e: TimeEntry): string {
  if (!e.staff) return 'Staff';
  return `${e.staff.firstName} ${e.staff.lastName}`.trim() || 'Staff';
}

/**
 * Compact time-tracking widget for the ticket-detail sidebar: shows total logged
 * time, a small log form (minutes + optional note), and the entry list.
 */
export function TimeTrackingPanel({ ticketId }: { ticketId: number }) {
  const { data, isLoading } = useTimeEntries(ticketId);
  const logTime = useLogTime(ticketId);
  const deleteEntry = useDeleteTimeEntry(ticketId);

  const [minutes, setMinutes] = useState('');
  const [note, setNote] = useState('');

  const entries = data?.entries ?? [];
  const totalMinutes = data?.totalMinutes ?? 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const mins = Number.parseInt(minutes, 10);
    if (!Number.isFinite(mins) || mins <= 0) return;
    logTime.mutate(
      { minutes: mins, note: note.trim() || undefined },
      {
        onSuccess: () => {
          setMinutes('');
          setNote('');
        },
      },
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          <Clock className="size-4" />
          Time tracked
        </h3>
        <span className="text-sm font-semibold tabular-nums">{formatMinutes(totalMinutes)}</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="time-minutes" className="text-xs">
            Minutes
          </Label>
          <Input
            id="time-minutes"
            type="number"
            min={1}
            inputMode="numeric"
            placeholder="30"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="h-8"
          />
        </div>
        <Input
          aria-label="Note"
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="h-8"
        />
        <Button type="submit" size="sm" className="w-full" disabled={logTime.isPending || !minutes}>
          {logTime.isPending ? 'Logging…' : 'Log time'}
        </Button>
      </form>

      <div className="space-y-1.5">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No time logged yet.</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium tabular-nums">{formatMinutes(entry.minutes)}</span>
                  <span className="text-muted-foreground">· {staffName(entry)}</span>
                </div>
                {entry.note ? <p className="truncate text-muted-foreground">{entry.note}</p> : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label="Delete entry"
                disabled={deleteEntry.isPending}
                onClick={() => deleteEntry.mutate(entry.id)}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
