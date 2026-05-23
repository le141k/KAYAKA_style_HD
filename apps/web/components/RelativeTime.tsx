'use client';

import { useEffect, useState } from 'react';
import { formatDate, formatRelative } from '@/lib/utils';

/**
 * Renders a relative timestamp ("5 мин назад") without triggering a React
 * hydration mismatch (#418).
 *
 * `formatRelative` depends on `Date.now()`, which differs between the server
 * render and the client hydration, so emitting it directly produces mismatched
 * HTML. Instead we render the deterministic absolute date on the server and the
 * first client paint (so the markup matches), then swap to the relative form
 * after mount.
 */
export function RelativeTime({
  date,
  className,
}: {
  date: string | Date | null | undefined;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const title = formatDate(date);
  return (
    <time className={className} title={title} suppressHydrationWarning>
      {mounted ? formatRelative(date) : title}
    </time>
  );
}
