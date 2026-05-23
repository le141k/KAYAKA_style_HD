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
import { useI18n } from '@/lib/i18n';

/** Render minutes as a compact "Hh Mm" / "Mm" string using localized units. */
function formatMinutes(total: number, hUnit: string, mUnit: string): string {
  if (total <= 0) return `0${mUnit}`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return [h > 0 ? `${h}${hUnit}` : '', m > 0 ? `${m}${mUnit}` : ''].filter(Boolean).join(' ') || `0${mUnit}`;
}

function staffName(e: TimeEntry): string {
  if (!e.staff) return '';
  return `${e.staff.firstName} ${e.staff.lastName}`.trim();
}

/**
 * Compact time-tracking widget for the ticket-detail sidebar: shows total logged
 * time, a small log form (minutes + optional note), and the entry list.
 */
export function TimeTrackingPanel({ ticketId }: { ticketId: number }) {
  const { t } = useI18n();
  const tt = t.timeTracking;
  const { data, isLoading } = useTimeEntries(ticketId);
  const logTime = useLogTime(ticketId);
  const deleteEntry = useDeleteTimeEntry(ticketId);
  const fmt = (n: number) => formatMinutes(n, tt.hours, tt.mins);

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
          {tt.title}
        </h3>
        <span className="text-sm font-semibold tabular-nums">{fmt(totalMinutes)}</span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor="time-minutes" className="text-xs">
            {tt.minutes}
          </Label>
          <Input
            id="time-minutes"
            type="number"
            min={1}
            inputMode="numeric"
            placeholder={tt.minutesPlaceholder}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="h-8"
          />
        </div>
        <Input
          aria-label={tt.notePlaceholder}
          placeholder={tt.notePlaceholder}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="h-8"
        />
        <Button type="submit" size="sm" className="w-full" disabled={logTime.isPending || !minutes}>
          {logTime.isPending ? tt.logging : tt.logTime}
        </Button>
      </form>

      <div className="space-y-1.5">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">{tt.loading}</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{tt.empty}</p>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-xs"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium tabular-nums">{fmt(entry.minutes)}</span>
                  {staffName(entry) ? (
                    <span className="text-muted-foreground">· {staffName(entry)}</span>
                  ) : null}
                </div>
                {entry.note ? <p className="truncate text-muted-foreground">{entry.note}</p> : null}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={tt.deleteEntry}
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
