import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(date: string | Date | null | undefined, locale = 'ru-RU'): string {
  if (!date) return '—';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function formatRelative(date: string | Date | null | undefined): string {
  if (!date) return '—';
  const then = new Date(date).getTime();
  if (Number.isNaN(then)) return '—';
  const now = Date.now();
  const diff = now - then;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  if (hours < 24) return `${hours} ч назад`;
  if (days < 7) return `${days} д назад`;
  return formatDate(date);
}

export function generateTicketMask(id: number): string {
  return `TT-${String(id).padStart(6, '0')}`;
}

export function getInitials(name: string | null | undefined): string {
  if (!name) return '—';
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}
