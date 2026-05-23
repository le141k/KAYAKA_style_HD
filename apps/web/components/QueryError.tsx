'use client';

import { AlertTriangle } from 'lucide-react';

/**
 * Honest error state for a failed data query. We render this instead of falling
 * back to fake/empty data, so an API 500/403 is visible to the user (and never
 * silently masked as "no results").
 */
export function QueryError({
  message = 'Не удалось загрузить данные. Проверьте соединение и попробуйте ещё раз.',
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center text-sm ' +
        (className ?? '')
      }
    >
      <AlertTriangle className="h-6 w-6 text-destructive" />
      <p className="text-foreground">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Повторить
        </button>
      )}
    </div>
  );
}
